import { log_msg as log } from "../util.js";

// V13 moved these former globals into namespaces; the bare `renderTemplate` /
// `TextEditor` globals are deprecated and warn until v15. Alias the namespaced
// versions once — falling back to the global only if the namespace isn't present —
// so the call sites below stay clean and quiet.
const renderTemplate = foundry.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
const TextEditor = foundry.applications?.ux?.TextEditor ?? globalThis.TextEditor;

const MODULE_ID = "ffg-star-wars-enhancements";
const FLAG_SPECIAL_AMMO = "special-ammo";
const FLAG_AMMO_DATA = "ammo-data";
// Snapshot of the ammo block stored on a chat message the first time it's
// processed, so re-renders (incl. page reloads) display it immutably.
const FLAG_AMMO_RESULT = "ammo-result";

const SETTING_ENABLE = "special-ammo-enable";
const SETTING_AUTO_DEPLETE = "special-ammo-auto-deplete";

export function init() {
    log("special_ammo", "Initializing");
    game.settings.register(MODULE_ID, SETTING_ENABLE, {
        name: game.i18n.localize("ffg-star-wars-enhancements.special-ammo.enable"),
        hint: game.i18n.localize("ffg-star-wars-enhancements.special-ammo.enable-hint"),
        scope: "world",
        config: true,
        type: Boolean,
        default: false,
    });
    game.settings.register(MODULE_ID, SETTING_AUTO_DEPLETE, {
        name: game.i18n.localize("ffg-star-wars-enhancements.special-ammo.auto-deplete"),
        hint: game.i18n.localize("ffg-star-wars-enhancements.special-ammo.auto-deplete-hint"),
        scope: "world",
        config: true,
        type: Boolean,
        default: false,
    });
    log("special_ammo", "Initialized");
}

export function hooks() {
    log("special_ammo", "Registering hooks");

    Hooks.on("renderItemSheet", async (app, html, data) => {
        if (!game.settings.get(MODULE_ID, SETTING_ENABLE)) return;
        const item = app.item ?? app.document;
        if (!item) return;

        if (item.type === "weapon") {
            await _injectWeaponAmmoUI(item, html);
        } else if (item.type === "gear") {
            await _injectGearAmmoUI(item, html);
        }
    });

    // V13 deprecated "renderChatMessage" (jQuery html) in favour of
    // "renderChatMessageHTML", which hands a native HTMLElement. Normalize back
    // to jQuery so the .find()/.append()/.on() calls below keep working.
    Hooks.on("renderChatMessageHTML", async (message, html, messageData) => {
        if (!game.settings.get(MODULE_ID, SETTING_ENABLE)) return;
        html = html instanceof HTMLElement ? $(html) : html;
        // Prevent processing the same rendered element twice.
        if (html.find(".special-ammo-chat").length > 0) return;

        // Resolve the ammo result ONCE per message. The computation decrements the
        // magazine, so concurrent re-renders of the SAME message (Dice So Nice's
        // re-render after the 3D roll, chat pop-outs, and the snapshot setFlag's own
        // re-render) must not each recompute — that would spend several rounds for a
        // single shot and could even flip a still-loaded weapon to empty.
        // _getAmmoSnapshot shares one in-flight computation per message id and
        // persists the result as a flag, so every later render (incl. after a page
        // reload) reuses it verbatim. A render hook must never throw unhandled.
        try {
            const snapshot = await _getAmmoSnapshot(message);
            if (!snapshot) return;
            await _renderSpecialAmmoBlock(html, snapshot);
        } catch (e) {
            log("special_ammo", `chat render failed: ${e}`);
        }
    });

    // Codex weapon cards (starwarsffg system). The Codex sheet renders only the
    // CORE ammo chip (system.ammo); the special-ammo selector + magazine are
    // ours to inject. These ApplicationV2 sheets hand the render callback a
    // native HTMLElement. See docs/handoff-codex-special-ammo.md.
    for (const cls of ["renderCodexActorSheet", "renderCodexAdversarySheet"]) {
        Hooks.on(cls, async (app, element, context, options) => {
            if (!game.settings.get(MODULE_ID, SETTING_ENABLE)) return;
            const root = element instanceof HTMLElement ? element : element?.[0];
            if (!root) return;
            try {
                await _injectCodexSpecialAmmo(app.document ?? app.actor, root);
            } catch (e) {
                log("special_ammo", `Codex special-ammo injection failed: ${e}`);
            }
        });
    }
}

// In-flight snapshot computations keyed by message id (see _getAmmoSnapshot).
const _ammoSnapshots = new Map();

/**
 * Resolve the special-ammo snapshot for a message, computing it AT MOST ONCE.
 * The render hook can fire repeatedly for one message before the first run's flag
 * write lands; sharing the in-flight promise by message id guarantees the magazine
 * is decremented exactly once. Returns null for non-special messages.
 */
async function _getAmmoSnapshot(message) {
    const existing = message.getFlag(MODULE_ID, FLAG_AMMO_RESULT);
    if (existing) return existing;
    if (_ammoSnapshots.has(message.id)) return _ammoSnapshots.get(message.id);

    const promise = (async () => {
        const snapshot = await _computeAmmoResult(message);
        // Only the author persists (and only the author decremented); other clients
        // render their freshly computed copy until the flag syncs to them.
        if (snapshot && message.author?.id === game.user.id) {
            try {
                await message.setFlag(MODULE_ID, FLAG_AMMO_RESULT, snapshot);
            } catch (e) { /* can't persist (e.g. permissions) — still render this session */ }
        }
        return snapshot;
    })();
    _ammoSnapshots.set(message.id, promise);
    try {
        return await promise;
    } finally {
        _ammoSnapshots.delete(message.id);
    }
}

/**
 * Compute the special-ammo result for a weapon-roll chat message: resolve the
 * loaded ammo, (on the author's client) decrement the magazine and run
 * auto-deplete, and return the template data for the chat block. Returns null
 * when the message isn't a special-ammo weapon roll. Run once per message via
 * _getAmmoSnapshot; the result is snapshotted onto the message so re-renders
 * never recompute.
 */
async function _computeAmmoResult(message) {
    if (!message.rolls || message.rolls.length === 0) return null;

    const roll = message.rolls[0];
    if (!roll.data || jQuery.isEmptyObject(roll.data)) return null;

    // The roll carries a SNAPSHOT of the weapon whose _id is a throwaway/transient
    // id (system 2.0.3 builds the roll from a temporary item). The LIVE weapon is
    // referenced by uuid — this is exactly how the system itself resolves it to
    // decrement core ammo (roll-builder.js: fromUuid(this.roll.item.uuid)). Resolve
    // by uuid first; fall back to id/name on the speaker's actor for older rolls.
    const weaponUuid = roll.data.uuid || roll.data.flags?.starwarsffg?.uuid;
    let weapon = weaponUuid ? await fromUuid(weaponUuid) : null;

    if (!weapon) {
        const speaker = message.speaker || {};
        let actor = null;
        if (speaker.token) {
            actor = (speaker.scene ? game.scenes.get(speaker.scene) : null)?.tokens?.get(speaker.token)?.actor
                 ?? game.actors?.tokens?.[speaker.token] ?? null;
        }
        if (!actor && speaker.actor) actor = game.actors.get(speaker.actor);
        if (actor) {
            weapon = actor.items.get(roll.data._id)
                  || (roll.data.name ? actor.items.find((i) => i.type === "weapon" && i.name === roll.data.name) : null);
        }
    }

    if (!weapon || weapon.type !== "weapon") return null;

    const actor = weapon.actor;
    if (!actor) return null;

    const flagData = weapon.getFlag(MODULE_ID, FLAG_SPECIAL_AMMO);
    if (!flagData?.hasSpecialAmmo) return null;

    const selectedAmmoId = flagData.selectedAmmo;
    if (!selectedAmmoId) return null;

    const ammoItem = actor.items.get(selectedAmmoId);
    if (!ammoItem) {
        log("special_ammo", "Selected ammo item no longer exists in inventory");
        return null;
    }

    const ammoData = ammoItem.getFlag(MODULE_ID, FLAG_AMMO_DATA);
    if (!ammoData || !ammoData.canBeUsedAsAmmo) return null;

    const rawDescription = ammoItem.system?.description || "";
    const description = rawDescription
        ? await TextEditor.enrichHTML(rawDescription)
        : "";
    // Spend a round. With auto-deplete the clip is backed by the item Quantity
    // (each Quantity = one clip of ammoMax): an empty clip is refilled from the
    // spares it is already counted against, and a clip that runs dry chambers the
    // next spare — so firing never strands ammo. Without auto-deplete the clip just
    // depletes and is reloaded by hand. Only the roll's author mutates state.
    // Quantity is the real ammo counter.
    const _isAuthor = message.author?.id === game.user.id;
    const _autoDeplete = game.settings.get(MODULE_ID, SETTING_AUTO_DEPLETE);

    let newCurrent = Number(ammoData.ammoCurrent) || 0;
    if (_isAuthor) {
        const max = Number(ammoData.ammoMax) || 0;
        let cur = newCurrent;
        const qty0 = Number(ammoItem.system?.quantity?.value ?? ammoItem.system?.quantity ?? 0) || 0;
        let qty = qty0;

        // Un-stick an empty clip: refill it from the spares it is already counted
        // against (no extra spare spent). This is what lets firing resume when a
        // clip got stranded at 0 with Quantity still behind it.
        if (cur <= 0 && _autoDeplete && max > 0 && qty > 0) {
            cur = max;
        }

        if (cur > 0) {
            cur -= 1;   // spend the round

            // Reload-after-empty: a clip that runs dry discards and chambers the next
            // spare; the last clip just empties.
            if (cur <= 0 && _autoDeplete && max > 0) {
                if (qty > 1) { qty -= 1; cur = max; }
                else { qty = 0; }
            }

            // TWO separate writes — both proven to persist in this build. A single
            // update() mixing the dotted system path with a nested flags object did
            // NOT reliably land the flag, which is what stranded clips at 0.
            if (qty !== qty0) await ammoItem.update({ "system.quantity.value": qty });
            await ammoItem.setFlag(MODULE_ID, FLAG_AMMO_DATA, { ...ammoData, ammoCurrent: cur });
            newCurrent = cur;
            log("special_ammo", `Used 1 ammo from ${ammoItem.name}. Clip ${cur}/${max}, ${qty} remaining.`);
        }
    }

    const magazinesLeft = ammoItem.system?.quantity?.value ?? ammoItem.system?.quantity ?? 0;
    const qualities = (ammoItem.system?.itemmodifier || []).map((mod) => {
        const name = mod.name || "";
        const rank = parseInt(mod.system?.rank) || 0;
        return {
            label: rank ? `${name} ${rank}` : name,
            qualityId: mod._id || "",
        };
    });

    return {
        ammoName: ammoItem.name,
        ammoImg: ammoItem.img,
        description: description,
        ammoCurrent: newCurrent,
        ammoMax: ammoData.ammoMax,
        weaponName: weapon.name,
        magazinesLeft: magazinesLeft,
        qualities: qualities,
        ammoItemId: ammoItem.id,
        actorId: actor.id,
    };
}

/**
 * Render the special-ammo chat block from a (snapshotted) template-data object
 * and wire the lazy quality-description tooltips.
 */
async function _renderSpecialAmmoBlock(html, templateData) {
    const ammoHtml = await renderTemplate(
        `modules/${MODULE_ID}/templates/specialAmmo/ammo_chat_message.html`,
        templateData
    );
    html.append(ammoHtml);

    // Lazy-load quality descriptions on hover
    html.find(".special-ammo-quality-pill").on("mouseenter", async function () {
        const pill = $(this);
        if (pill.data("tooltip-loaded")) return;
        const qualityId = pill.data("quality-id");
        const ammoId = pill.data("ammo-id");
        const actId = pill.data("actor-id");
        const act = game.actors.get(actId);
        if (!act) return;
        const ammo = act.items.get(ammoId);
        if (!ammo) return;
        const mod = (ammo.system?.itemmodifier || []).find((m) => m._id === qualityId);
        if (!mod) return;
        const desc = mod.system?.description || "";
        if (desc) {
            const enriched = await TextEditor.enrichHTML(desc);
            pill.attr("data-tooltip", enriched);
            pill.attr("data-tooltip-direction", "UP");
        }
        pill.data("tooltip-loaded", true);
    });
}

/**
 * Get valid ammo items for a weapon from its owning actor.
 */
function _getValidAmmoItems(weapon) {
    const actor = weapon.actor;
    if (!actor) return [];

    const flagData = weapon.getFlag(MODULE_ID, FLAG_SPECIAL_AMMO);
    if (!flagData?.hasSpecialAmmo) return [];

    const filterStr = flagData.ammoFilter || "";
    const allowedNames = filterStr
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0);

    if (allowedNames.length === 0) return [];

    // Resolve each filter name to a usable ammo item, recording why a named item is
    // skipped. A gear item qualifies only if it (a) exists in inventory, (b) is type
    // "gear", and (c) has "Can Be Used As Ammo" enabled on its own sheet — naming it
    // in the weapon's filter is necessary but NOT sufficient (that flag also stores
    // the magazine size). The skip reasons surface in the console when starwarsffg
    // debug logging is on, turning a silently empty dropdown into an explanation.
    const valid = [];
    const skipped = [];
    for (const name of allowedNames) {
        const named = actor.items.filter((i) => i.name.toLowerCase() === name);
        if (named.length === 0) {
            skipped.push(`"${name}" — no item by that name in inventory`);
            continue;
        }
        const gear = named.filter((i) => i.type === "gear");
        if (gear.length === 0) {
            skipped.push(`"${name}" — exists but is type '${named[0].type}', not 'gear'`);
            continue;
        }
        const usable = gear.filter((i) => i.getFlag(MODULE_ID, FLAG_AMMO_DATA)?.canBeUsedAsAmmo === true);
        if (usable.length === 0) {
            skipped.push(`"${name}" — gear item found but "Can Be Used As Ammo" is not enabled on it`);
            continue;
        }
        valid.push(...usable);
    }
    if (skipped.length) {
        log("special_ammo", `Ammo selector for "${weapon.name}": ${valid.length} usable, ${skipped.length} skipped — ${skipped.join("; ")}`);
    }
    return valid;
}

/**
 * Build the special-ammo magazine stepper for a loaded ammo item. Reuses the
 * system's .cdx-ammo-stepper/.cdx-ammo-step/.cdx-ammo-count classes for styling;
 * the extra .cdx-ammo-special-stepper class distinguishes it from the system's
 * core stepper. The −/+ adjust the AMMO ITEM's ammo-data.ammoCurrent (clamped to
 * [0, ammoMax]) with {render:false} + an optimistic DOM update so editing does
 * not collapse the expanded card.
 */
function _buildCodexMagazine(ammoItem) {
    const wrap = document.createElement("div");
    wrap.className = "cdx-ammo-stepper cdx-ammo-special-stepper";

    const ad = ammoItem.getFlag(MODULE_ID, FLAG_AMMO_DATA) || {};
    const max = Number(ad.ammoMax) || 0;
    const cur = Math.max(0, Number(ad.ammoCurrent) || 0);

    const minus = document.createElement("button");
    minus.type = "button";
    minus.className = "cdx-ammo-step";
    minus.dataset.dir = "-1";
    minus.innerHTML = '<i class="fas fa-minus"></i>';

    const count = document.createElement("span");
    count.className = "cdx-ammo-count";
    count.textContent = `${cur}/${max}`;

    const plus = document.createElement("button");
    plus.type = "button";
    plus.className = "cdx-ammo-step";
    plus.dataset.dir = "1";
    plus.innerHTML = '<i class="fas fa-plus"></i>';

    const adjust = async (dir) => {
        const data = ammoItem.getFlag(MODULE_ID, FLAG_AMMO_DATA) || {};
        const mx = Number(data.ammoMax) || 0;
        let next = (Number(data.ammoCurrent) || 0) + dir;
        next = Math.max(0, mx ? Math.min(mx, next) : next);
        try {
            // Nested-object form (what setFlag uses) — the dotted-string key
            // form did NOT persist these flags in this build.
            await ammoItem.update(
                { flags: { [MODULE_ID]: { [FLAG_AMMO_DATA]: { ...data, ammoCurrent: next } } } },
                { render: false }
            );
        } catch (e) {
            return;
        }
        count.textContent = `${next}/${mx}`;
    };
    minus.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); adjust(-1); });
    plus.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); adjust(1); });

    wrap.append(minus, count, plus);
    return wrap;
}

/**
 * Inject the special-ammo selector (+ magazine when an ammo is loaded) into the
 * Codex weapon cards' ammo chip. Mirrors the renderItemSheet injection but for
 * the ApplicationV2 actor sheet, where the render hook hands us a native DOM
 * root. Idempotent: the hook fires on every render, so we never double-inject.
 */
async function _injectCodexSpecialAmmo(actor, root) {
    if (!actor) return;

    for (const card of root.querySelectorAll(".cdx-card.weapon[data-item-id]")) {
        const weapon = actor.items.get(card.dataset.itemId);
        if (!weapon) continue;

        const sa = weapon.getFlag(MODULE_ID, FLAG_SPECIAL_AMMO);
        if (!sa?.hasSpecialAmmo) continue;

        // Idempotency — the sheet re-renders often; never double-inject.
        if (card.querySelector(".cdx-ammo-special")) continue;

        const validItems = _getValidAmmoItems(weapon);

        // If the persisted selection no longer resolves to a valid ammo item,
        // display it as unselected — but do NOT persist a clear here. Writing
        // during the render hook can race and wipe the flag (e.g. before the
        // actor's gear items are ready on initial load). The selection is only
        // ever cleared by an explicit user choice in the selector.
        let selectedAmmo = sa.selectedAmmo || "";
        if (selectedAmmo && !validItems.find((i) => i.id === selectedAmmo)) {
            selectedAmmo = "";
        }

        // Reuse the system's core-ammo chip if present (weapon has config.enableAmmo);
        // otherwise create one — the system CSS then places + shows it (centered,
        // full-width under the card) on expand. The chip is just our host container;
        // the visible UI is the self-contained panel built below.
        let chip = card.querySelector(".cdx-ammo");
        if (!chip) {
            chip = document.createElement("div");
            chip.className = "cdx-ammo";
            chip.dataset.weaponId = weapon.id;
            chip.addEventListener("click", (ev) => ev.stopPropagation());
            card.appendChild(chip);
        } else {
            // Reusing the system's core chip: hide its "AMMO" label — our panel
            // carries its own centered title instead.
            chip.querySelector(".cdx-ammo-k")?.style.setProperty("display", "none");
        }

        // Self-contained panel (its own block) mirroring the .cdx-idesc look: an
        // accent header bar over a paper body, themed via the inherited --cdx-*
        // vars so it works on every scheme with no module stylesheet. Layout:
        // centered title on the first row, then the selector + magazine inline.
        const panel = document.createElement("div");
        panel.className = "cdx-ammo-special-panel";
        Object.assign(panel.style, {
            display: "flex", flexDirection: "column", width: "100%",
            background: "var(--cdx-paper2)", border: "1px solid var(--cdx-line)", borderRadius: "4px",
        });

        const title = document.createElement("div");
        title.className = "cdx-ammo-special-title";
        title.textContent = game.i18n.localize("ffg-star-wars-enhancements.special-ammo.selector-title");
        Object.assign(title.style, {
            background: "var(--cdx-accent)", color: "#fff", textAlign: "center",
            fontFamily: "Orbitron", fontWeight: "700", fontSize: "10px", letterSpacing: "1.2px",
            textTransform: "uppercase", padding: "5px 10px", borderRadius: "4px 4px 0 0",
        });

        const row = document.createElement("div");
        row.className = "cdx-ammo-special-row";
        Object.assign(row.style, {
            display: "flex", flexDirection: "row", alignItems: "center", justifyContent: "center",
            gap: "10px", padding: "8px 10px",
        });

        // Slot holding either the loaded ammo's magazine or — when nothing is loaded
        // — the system's core stepper, kept inline to the right of the selector. Move
        // the core stepper (if any) in here; it stays a descendant of .cdx-ammo, so
        // the system's closest(".cdx-ammo") click handler keeps working.
        const stepperSlot = document.createElement("div");
        stepperSlot.className = "cdx-ammo-special-slot";
        Object.assign(stepperSlot.style, { display: "flex", alignItems: "center" });
        const movedCore = chip.querySelector(".cdx-ammo-stepper:not(.cdx-ammo-special-stepper)");
        if (movedCore) stepperSlot.appendChild(movedCore);

        // Selector — a custom dropdown of regular elements (a native <select>
        // popup ignores CSS in Foundry's Chromium build and renders unreadable on
        // the dark scheme). All styling is set INLINE and visibility is toggled in
        // JS, so it works regardless of whether any module stylesheet is loaded;
        // colours resolve the active scheme via the inherited --cdx-* variables.
        const noneLabel = game.i18n.localize("ffg-star-wars-enhancements.special-ammo.none");
        const labelFor = (id) => (id ? (validItems.find((i) => i.id === id)?.name ?? noneLabel) : noneLabel);

        const dropdown = document.createElement("div");
        dropdown.className = "cdx-ammo-select cdx-ammo-special";
        Object.assign(dropdown.style, {
            position: "relative", flex: "1 1 auto", minWidth: "0",
            fontFamily: "Orbitron", fontSize: "10px", color: "var(--cdx-ink)", cursor: "pointer", userSelect: "none",
        });

        const trigger = document.createElement("div");
        trigger.className = "cdx-ammo-trigger";
        Object.assign(trigger.style, {
            display: "flex", alignItems: "center", justifyContent: "space-between",
            gap: "6px", background: "var(--cdx-paper)", border: "1px solid var(--cdx-line)",
            borderRadius: "3px", padding: "3px 8px",
        });
        const triggerLabel = document.createElement("span");
        Object.assign(triggerLabel.style, { flex: "1", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
        triggerLabel.textContent = labelFor(selectedAmmo);
        const caret = document.createElement("i");
        caret.className = "fas fa-caret-down";
        trigger.append(triggerLabel, caret);

        // Absolutely positioned so opening the list overlays the content below
        // rather than pushing the inline stepper around.
        const optionsBox = document.createElement("div");
        optionsBox.className = "cdx-ammo-options";
        Object.assign(optionsBox.style, {
            display: "none", position: "absolute", top: "100%", left: "0", width: "100%", marginTop: "2px",
            zIndex: "100", background: "var(--cdx-paper)", border: "1px solid var(--cdx-line)", borderRadius: "3px",
            maxHeight: "160px", overflowY: "auto", boxShadow: "0 4px 14px rgba(0,0,0,.45)",
        });

        const paintOption = (opt) => {
            const sel = opt.dataset.value === selectedAmmo;
            opt.style.background = sel ? "var(--cdx-accent)" : "transparent";
            opt.style.color = sel ? "var(--cdx-chip-ink)" : "var(--cdx-ink)";
        };
        const addOption = (value, text) => {
            const opt = document.createElement("div");
            opt.className = "cdx-ammo-option";
            opt.dataset.value = value;
            opt.textContent = text;
            Object.assign(opt.style, { padding: "3px 6px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
            paintOption(opt);
            opt.addEventListener("mouseenter", () => { opt.style.background = "var(--cdx-accent)"; opt.style.color = "var(--cdx-chip-ink)"; });
            opt.addEventListener("mouseleave", () => paintOption(opt));
            optionsBox.appendChild(opt);
        };
        addOption("", noneLabel);
        for (const it of validItems) addOption(it.id, it.name);

        dropdown.append(trigger, optionsBox);

        // Assemble the panel: centered title row, then selector + stepper inline.
        row.append(dropdown, stepperSlot);
        panel.append(title, row);
        chip.appendChild(panel);

        // Show the special magazine for the loaded ammo, or the core stepper when
        // nothing is loaded. "Special if loaded, else core." Both live in stepperSlot.
        const applySelection = (selId) => {
            const selItem = selId ? validItems.find((i) => i.id === selId) : null;
            stepperSlot.querySelector(".cdx-ammo-special-stepper")?.remove();
            // The system's core stepper, if any, is the .cdx-ammo-stepper that is NOT ours.
            const coreStepper = stepperSlot.querySelector(".cdx-ammo-stepper:not(.cdx-ammo-special-stepper)");
            if (selItem) {
                if (coreStepper) coreStepper.style.display = "none";
                stepperSlot.appendChild(_buildCodexMagazine(selItem));
            } else if (coreStepper) {
                coreStepper.style.display = "";
            }
        };

        // Swallow clicks inside the dropdown so they don't toggle the card's expand.
        dropdown.addEventListener("click", (ev) => ev.stopPropagation());
        const setOpen = (v) => { optionsBox.style.display = v ? "block" : "none"; };
        trigger.addEventListener("click", (ev) => {
            ev.stopPropagation();
            setOpen(optionsBox.style.display === "none");
        });

        const selectAmmo = async (value) => {
            try {
                const cur = weapon.getFlag(MODULE_ID, FLAG_SPECIAL_AMMO) || {};
                // Nested-object form (what setFlag uses) — the dotted-string key
                // form does NOT persist this flag. {render:false} keeps the
                // expanded card from collapsing.
                await weapon.update(
                    { flags: { [MODULE_ID]: { [FLAG_SPECIAL_AMMO]: { ...cur, selectedAmmo: value } } } },
                    { render: false }
                );

                // Loading an ammo reloads its magazine: if the chosen ammo's
                // magazine is empty but spares remain, fill it to max. (Auto-deplete
                // model, where the quantity count includes the loaded magazine, so
                // we don't consume a spare here.) This is why firing a freshly
                // re-stocked ammo no longer reports "out of ammo".
                const ammoItem = value ? validItems.find((i) => i.id === value) : null;
                if (ammoItem && game.settings.get(MODULE_ID, SETTING_AUTO_DEPLETE)) {
                    const ad = ammoItem.getFlag(MODULE_ID, FLAG_AMMO_DATA) || {};
                    const max = Number(ad.ammoMax) || 0;
                    const qty = ammoItem.system?.quantity?.value ?? ammoItem.system?.quantity ?? 0;
                    if ((Number(ad.ammoCurrent) || 0) <= 0 && max > 0 && qty > 0) {
                        await ammoItem.update(
                            { flags: { [MODULE_ID]: { [FLAG_AMMO_DATA]: { ...ad, ammoCurrent: max } } } },
                            { render: false }
                        );
                    }
                }
            } catch (e) {
                return;
            }
            selectedAmmo = value;
            triggerLabel.textContent = labelFor(value);
            optionsBox.querySelectorAll(".cdx-ammo-option").forEach(paintOption);
            applySelection(value);
        };

        optionsBox.addEventListener("click", (ev) => {
            const opt = ev.target.closest(".cdx-ammo-option");
            if (!opt) return;
            ev.stopPropagation();
            setOpen(false);
            selectAmmo(opt.dataset.value);
        });

        // Close the open list when clicking elsewhere in the sheet.
        root.addEventListener("click", (ev) => {
            if (!dropdown.contains(ev.target)) setOpen(false);
        });

        applySelection(selectedAmmo);
    }
}

/**
 * Inject special ammo UI into weapon item sheet configuration tab.
 */
async function _injectWeaponAmmoUI(weapon, html) {
    const flagData = weapon.getFlag(MODULE_ID, FLAG_SPECIAL_AMMO) || {};
    const hasSpecialAmmo = flagData.hasSpecialAmmo || false;
    const ammoFilter = flagData.ammoFilter || "";
    let selectedAmmo = flagData.selectedAmmo || "";

    // If the persisted selection doesn't currently resolve to a valid ammo item,
    // show it as unselected — but do NOT persist a clear here. Writing during the
    // render hook can race and wipe the flag (e.g. before the actor's gear items are
    // ready on initial load, or while an ammoFilter typo transiently matches none).
    // The selection is only ever cleared by an explicit user choice. Mirrors the
    // Codex card path; a stale id resolves to no chat block, which is harmless.
    if (selectedAmmo && weapon.actor) {
        const validItems = _getValidAmmoItems(weapon);
        if (!validItems.find((i) => i.id === selectedAmmo)) {
            selectedAmmo = "";
        }
    }

    // Get valid ammo items for the selector
    const ammoItems = hasSpecialAmmo ? _getValidAmmoItems(weapon) : [];

    const templateData = {
        hasSpecialAmmo,
        ammoFilter,
        selectedAmmo,
        ammoItems,
    };

    // The Codex II weapon sheet (ApplicationV2) uses codex markup + .cdx-pane
    // tabs; use a codex-styled template and inject into the configuration pane.
    const isCodex = html.hasClass("cdx-item") || html.find(".cdx-item-body").length > 0 || html.closest(".cdx").length > 0;

    const rendered = await renderTemplate(
        `modules/${MODULE_ID}/templates/specialAmmo/${isCodex ? "weapon_special_ammo_codex.html" : "weapon_special_ammo.html"}`,
        templateData
    );

    const configTab = isCodex
        ? html.find('.cdx-pane[data-tab="configuration"]')
        : html.find('.tab[data-tab="configuration"]');
    if (configTab.length) {
        configTab.append(rendered);
    }

    // Activate listeners
    const container = html.find(".special-ammo-settings");

    container.find('input[name="flags.special-ammo.hasSpecialAmmo"]').on("change", async (ev) => {
        const checked = ev.currentTarget.checked;
        await weapon.setFlag(MODULE_ID, FLAG_SPECIAL_AMMO, {
            ...weapon.getFlag(MODULE_ID, FLAG_SPECIAL_AMMO),
            hasSpecialAmmo: checked,
        });
    });

    container.find('input[name="flags.special-ammo.ammoFilter"]').on("change", async (ev) => {
        const value = ev.currentTarget.value;
        await weapon.setFlag(MODULE_ID, FLAG_SPECIAL_AMMO, {
            ...weapon.getFlag(MODULE_ID, FLAG_SPECIAL_AMMO),
            ammoFilter: value,
        });
    });

    container.find('select[name="flags.special-ammo.selectedAmmo"]').on("change", async (ev) => {
        const value = ev.currentTarget.value;
        await weapon.setFlag(MODULE_ID, FLAG_SPECIAL_AMMO, {
            ...weapon.getFlag(MODULE_ID, FLAG_SPECIAL_AMMO),
            selectedAmmo: value,
        });
    });
}

/**
 * Inject ammo data UI into gear item sheet.
 */
async function _injectGearAmmoUI(gear, html) {
    const flagData = gear.getFlag(MODULE_ID, FLAG_AMMO_DATA) || {};
    const canBeUsedAsAmmo = flagData.canBeUsedAsAmmo || false;
    const ammoMax = flagData.ammoMax ?? 0;
    const ammoCurrent = flagData.ammoCurrent ?? 0;

    // Progress track for the codex ammo block — only when threshold > 1. Mirrors
    // the system's _cdxTrack (green → amber → red; pips for small, bar for large).
    let track = null;
    if (canBeUsedAsAmmo && ammoMax > 1) {
        const ratio = ammoMax > 0 ? ammoCurrent / ammoMax : 0;
        // Inverted vs wound/strain: a FULL magazine is "good" (green), an empty
        // one is "bad" (red).
        const color = ratio <= 0.2 ? "#a51f17" : ratio < 0.5 ? "#c8902e" : "#3f7d3a";
        if (ammoMax >= 20) {
            track = { useBar: true, color, pct: Math.max(0, Math.min(100, Math.round(ratio * 100))) };
        } else {
            const pips = [];
            for (let i = 0; i < ammoMax; i++) pips.push(i < ammoCurrent);
            track = { useBar: false, color, pips };
        }
    }

    const templateData = {
        canBeUsedAsAmmo,
        ammoMax,
        ammoCurrent,
        track,
    };

    // On the Codex II item sheet, use the codex-class variant so the injected UI
    // matches the active scheme (styled by the system's cdx.css).
    const isCodex = html.hasClass("cdx-item") || html.find(".cdx-item-body").length > 0 || html.closest(".cdx").length > 0;

    const rendered = await renderTemplate(
        `modules/${MODULE_ID}/templates/specialAmmo/${isCodex ? "gear_ammo_codex.html" : "gear_ammo.html"}`,
        templateData
    );

    // Inject the block. The Codex II gear sheet (ApplicationV2) has a
    // .cdx-item-body (no .sheet-body); the stock sheet uses .weapon-values /
    // .sheet-body.
    if (isCodex) {
        const codexBody = html.find(".cdx-item-body").first();
        if (codexBody.length) {
            codexBody.prepend(rendered);
        }
    } else {
        const weaponValues = html.find(".weapon-values").last();
        if (weaponValues.length) {
            weaponValues.after(rendered);
        } else {
            // Fallback: inject before sheet-body tabs
            const sheetBody = html.find(".sheet-body");
            if (sheetBody.length) {
                sheetBody.prepend(rendered);
            }
        }
    }

    // Activate listeners
    const container = html.find(".gear-ammo-settings");

    container.find('input[name="flags.ammo-data.canBeUsedAsAmmo"]').on("change", async (ev) => {
        const checked = ev.currentTarget.checked;
        await gear.setFlag(MODULE_ID, FLAG_AMMO_DATA, {
            ...gear.getFlag(MODULE_ID, FLAG_AMMO_DATA),
            canBeUsedAsAmmo: checked,
        });
    });

    container.find('input[name="flags.ammo-data.ammoMax"]').on("change", async (ev) => {
        const value = parseInt(ev.currentTarget.value) || 0;
        await gear.setFlag(MODULE_ID, FLAG_AMMO_DATA, {
            ...gear.getFlag(MODULE_ID, FLAG_AMMO_DATA),
            ammoMax: value,
        });
    });

    container.find('input[name="flags.ammo-data.ammoCurrent"]').on("change", async (ev) => {
        const value = parseInt(ev.currentTarget.value) || 0;
        await gear.setFlag(MODULE_ID, FLAG_AMMO_DATA, {
            ...gear.getFlag(MODULE_ID, FLAG_AMMO_DATA),
            ammoCurrent: value,
        });
    });

    // Codex magazine steppers (−/+): adjust ammoCurrent, clamped to [0, threshold].
    // The setFlag re-renders the sheet, which re-injects the block with the new
    // value and refreshed track.
    container.find(".gear-ammo-step").on("click", async (ev) => {
        ev.preventDefault();
        const dir = Number(ev.currentTarget.dataset.dir) || 0;
        const data = gear.getFlag(MODULE_ID, FLAG_AMMO_DATA) || {};
        const mx = Number(data.ammoMax) || 0;
        let cur = (Number(data.ammoCurrent) || 0) + dir;
        cur = Math.max(0, mx ? Math.min(mx, cur) : cur);
        await gear.setFlag(MODULE_ID, FLAG_AMMO_DATA, { ...data, ammoCurrent: cur });
    });

    // Inject qualities list when "can be used as ammo" is enabled
    if (canBeUsedAsAmmo) {
        await _injectGearQualities(gear, html, isCodex);
    }
}

/**
 * Build summarized qualities from a gear item's itemmodifier array.
 */
function _summarizeQualities(gear) {
    const modifiers = gear.system?.itemmodifier || [];
    const qualities = [];

    for (let i = 0; i < modifiers.length; i++) {
        const mod = modifiers[i];
        const name = mod.name || "";
        const rank = parseInt(mod.system?.rank) || 0;
        const description = mod.system?.description || "";

        const existing = qualities.find((q) => q.name === name);
        if (existing) {
            existing.totalRanks += rank;
            existing.summarizedRanks["mods"] = (existing.summarizedRanks["mods"] || 0) + rank;
        } else {
            qualities.push({
                name: name,
                description: description,
                modId: mod._id || i.toString(),
                itemIndex: i,
                totalRanks: rank,
                summarizedRanks: { mods: rank },
                includeControls: true,
            });
        }
    }

    return qualities;
}

/**
 * Inject qualities list into gear item sheet and handle drag-drop + delete.
 */
async function _injectGearQualities(gear, html, isCodex = false) {
    const qualities = _summarizeQualities(gear);

    const rendered = await renderTemplate(
        `modules/${MODULE_ID}/templates/specialAmmo/${isCodex ? "gear_qualities_codex.html" : "gear_qualities.html"}`,
        { qualities }
    );

    // Inject into the attributes tab. The Codex II gear sheet uses
    // .cdx-pane[data-tab="attributes"] instead of .tab[data-tab="..."].
    const attributesTab = isCodex
        ? html.find('.cdx-pane[data-tab="attributes"]')
        : html.find('.tab[data-tab="attributes"]');
    if (attributesTab.length) {
        attributesTab.prepend(rendered);
    }

    // Handle edit quality
    html.find(".gear-ammo-quality-edit").on("click", async (ev) => {
        ev.stopPropagation();
        const li = $(ev.currentTarget).closest(".item");
        const clickedId = li.data("item-id");
        const clickedType = li.data("item-type");
        const parentObject = await fromUuid(gear.uuid);
        let clickedObject = parentObject.system[clickedType].find(i => i._id === clickedId);
        if (!clickedObject) {
            clickedObject = parentObject.system[clickedType].find(i => i.name === li.data("upgrade-name"));
        }
        const { itemEditor } = await import("../../../../systems/starwarsffg/modules/items/item-editor.js"); // TODO: if item-editor can be exported, we could've used less fragile import method, but should work so far
        const typeChoices = {};
        for (const key of Object.keys(CONFIG.FFG.itemmodifier_types)) {
            const entry = CONFIG.FFG.itemmodifier_types[key];
            typeChoices[entry.value] = game.i18n.localize(entry.label);
        }
        const data = {
            sourceObject: gear,
            clickedObject: clickedObject,
            typeChoices: typeChoices,
        };
        new itemEditor(data).render(true);
    });

    // Handle delete quality
    html.find(".gear-ammo-quality-delete").on("click", async (ev) => {
        const li = $(ev.currentTarget).closest(".item");
        const itemIndex = parseInt(li.data("item-index"));
        if (isNaN(itemIndex)) return;

        const modifiers = [...(gear.system.itemmodifier || [])];
        modifiers.splice(itemIndex, 1);
        await gear.update({ "system.itemmodifier": modifiers });
    });

    // Handle drag-drop for adding qualities
    const dropTarget = html.find(".gear-ammo-qualities")[0];
    if (dropTarget) {
        dropTarget.addEventListener("dragover", (ev) => {
            ev.preventDefault();
            ev.dataTransfer.dropEffect = "copy";
        });

        dropTarget.addEventListener("drop", async (ev) => {
            ev.preventDefault();
            let data;
            try {
                data = JSON.parse(ev.dataTransfer.getData("text/plain"));
            } catch (e) {
                return;
            }

            const droppedItem = await fromUuid(data.uuid);
            if (!droppedItem || droppedItem.type !== "itemmodifier") return;

            const modifiers = [...(gear.system.itemmodifier || [])];
            const existing = modifiers.find((m) => m.name === droppedItem.name);
            if (existing) {
                existing.system.rank = (
                    parseInt(existing.system.rank) + parseInt(droppedItem.system.rank)
                ).toString();
            } else {
                const newMod = droppedItem.toObject();
                newMod._id = foundry.utils.randomID();
                modifiers.push(newMod);
            }
            await gear.update({ "system.itemmodifier": modifiers });
        });
    }
}
