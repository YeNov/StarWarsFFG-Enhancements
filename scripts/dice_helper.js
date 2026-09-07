import { log_msg as log } from "./util.js";

let feature_name = "dice_helper";
let _cachedData = null;
let _cacheJournalName = null;

export function invalidate_cache() {
    _cachedData = null;
    _cacheJournalName = null;
}

export function init() {
    log(feature_name, "Initializing");
    game.settings.register("ffg-star-wars-enhancements", "dice-helper", {
        name: game.i18n.localize("ffg-star-wars-enhancements.dice-helper"),
        hint: game.i18n.localize("ffg-star-wars-enhancements.dice-helper-hint"),
        scope: "world",
        config: true,
        type: Boolean,
        default: true,
    });
    game.settings.register("ffg-star-wars-enhancements", "dice-helper-data", {
        name: game.i18n.localize("ffg-star-wars-enhancements.dice-helper-data"),
        hint: game.i18n.localize("ffg-star-wars-enhancements.dice-helper-data-hint"),
        scope: "world",
        config: true,
        type: String,
        default: "dice_helper",
        // the cache is keyed on the journal name, so pointing the setting at a different journal
        // (or back at a previous one) has to drop it rather than rely on the key matching
        onChange: () => invalidate_cache(),
    });
    log(feature_name, "Initialized");
}

/*
Socket data handler which transfers items to the purchaser
 */
async function socket_listener(data) {
    if (data.type === "dice") {
        if (game.user.isGM) {
            dice_helper_clicked(data.object);
        }
    }
}

export function dice_helper() {
    game.socket.on("module.ffg-star-wars-enhancements", socket_listener);

    // Invalidate cached data only when the configured dice helper journal is modified
    const invalidateIfDiceHelperJournal = (document, changes) => {
        if (!_cachedData) {
            return;
        }
        // a rename can move a journal in or out of the configured name, and the document already
        // carries the new name by the time we see it, so drop the cache for any rename at all
        if (changes && "name" in changes) {
            invalidate_cache();
            return;
        }
        // page hooks pass the page (its entry is the parent), entry hooks pass the entry itself
        if (document?.parent?.name === _cacheJournalName || document?.name === _cacheJournalName) {
            invalidate_cache();
        }
    };
    Hooks.on("updateJournalEntryPage", invalidateIfDiceHelperJournal);
    Hooks.on("createJournalEntryPage", invalidateIfDiceHelperJournal);
    Hooks.on("deleteJournalEntryPage", invalidateIfDiceHelperJournal);
    // pages created as part of their parent entry (i.e. an import) do not fire the page hooks above,
    // and a new or deleted entry changes which journal the name resolves to
    Hooks.on("createJournalEntry", invalidateIfDiceHelperJournal);
    Hooks.on("updateJournalEntry", invalidateIfDiceHelperJournal);
    Hooks.on("deleteJournalEntry", invalidateIfDiceHelperJournal);

    // Use document-level event delegation for button clicks (works after page refresh)
    $(document).off("click", ".effg-die-result"); // Remove any existing handlers
    $(document).on("click", ".effg-die-result", async function (event) {
        event.preventDefault();
        event.stopPropagation();
        
        // Find the message element that contains this button
        let messageElement = $(this).closest(".message");
        
        if (messageElement.length === 0) {
            return;
        }
        
        // Get the message ID from the data attribute or message element
        let messageId = messageElement.data("message-id") || messageElement.attr("data-message-id");
        if (!messageId) {
            // Try to get it from the message element's ID
            let messageIdAttr = messageElement.attr("id");
            if (messageIdAttr) {
                messageId = messageIdAttr.replace("chat-message-", "");
            }
        }
        
        if (!messageId) {
            return;
        }
        
        // Get the message document
        let msg = game.messages.get(messageId);
        if (!msg) {
            return;
        }
        
        // Create wrapper for dice_helper_clicked
        let wrapper = {
            message: msg,
            _id: msg._id
        };
        await dice_helper_clicked(wrapper);
    });
    
    Hooks.on("createChatMessage", (messageData, meta_data, id) => {
        if (game.settings.get("ffg-star-wars-enhancements", "dice-helper")) {
            if (is_roll(messageData) === true) {
                // as of some v10 version, chat messages can contain >1 roll. let's just read the first
                messageData["_roll"] = messageData.rolls[0];
                let skill = messageData["flavor"]
                    .replace(game.i18n.localize("SWFFG.Rolling") + " ", "")
                    .replace("...", "")
                    .replace(/\s/g, " ");
                let roll_result = {
                    advantage: messageData["_roll"]["ffg"]["advantage"],
                    triumph: messageData["_roll"]["ffg"]["triumph"],
                    threat: messageData["_roll"]["ffg"]["threat"],
                    despair: messageData["_roll"]["ffg"]["despair"],
                    success: messageData["_roll"]["ffg"]["success"],
                    failure: messageData["_roll"]["ffg"]["failure"],
                };
                if (
                    roll_result["advantage"] > 0 ||
                    roll_result["triumph"] > 0 ||
                    roll_result["threat"] > 0 ||
                    roll_result["despair"] > 0
                ) {
                    log(feature_name, "Die roll had relevant results, generating new message");
                    // do we have a helper for this skill?
                    let data = load_data();
                    if (!is_supported_skill(skill.toLowerCase(), data)) {
                        log(feature_name, "Unable to find helper contents in journal, quitting");
                        return;
                    }

                    var msg = {
                        content:
                            '<button class="effg-die-result" ' +
                            'data-ad="' +
                            roll_result["advantage"] +
                            '" ' +
                            'data-tr="' +
                            roll_result["triumph"] +
                            '" ' +
                            'data-th="' +
                            roll_result["threat"] +
                            '" ' +
                            'data-de="' +
                            roll_result["despair"] +
                            '" ' +
                            'data-su="' +
                            roll_result["success"] +
                            '" ' +
                            'data-fa="' +
                            roll_result["failure"] +
                            '" ' +
                            'data-sk="' +
                            skill +
                            '"' +
                            ">" +
                            game.i18n.localize("ffg-star-wars-enhancements.dice-helper-button-text") +
                            "!</button>",
                    };
                    log(feature_name, "New message content: " + msg["content"]);
                    ChatMessage.create(msg);
                }
            } else {
                log(feature_name, "Detected message without roll; ignoring");
            }
        }
    });

    Hooks.on("renderChatMessage", (app, html, messageData) => {
        /*
        this is slightly less performant than doing the settings check outside of the hook, but if we do it above the
        hook and the user enables it after the game starts, it doesn't actually enable

        we can probably overcome that, but it requires a bunch more work and who has time for that?!
         */
        if (game.settings.get("ffg-star-wars-enhancements", "dice-helper")) {
            // Remove any existing handlers to prevent duplicates
            html.off("click", ".effg-die-result");
            
            // this would need to remain in renderchatmessage since we don't have easy access to the HTML later
            html.on("click", ".effg-die-result", async function (event) {
                event.preventDefault();
                event.stopPropagation();
                await dice_helper_clicked(app);
            });
        }
    });
}

function is_roll(message_data) {
    if (game.user.isGM && message_data["rolls"].length > 0) {
        if (message_data["flavor"] === undefined) {
            return false;
        }
        return true;
        if (
            message_data.message.content.search("Initiative") === -1 ||
            message_data.message.content.search(
                game.i18n.localize("ffg-star-wars-enhancements.dice-helper-button-text")
            ) === -1 ||
            message_data.message.content.search(
                game.i18n.localize("ffg-star-wars-enhancements.dice-helper-message-content-3")
            ) === -1
        ) {
            return true;
        }
    }
    return false;
}

async function dice_helper_clicked(object) {
    /**
     * update the content of the "help me spend results" button based on results of the dice roll
     *
     * @param {object} ChatMessage object passed in by the hook we're listened to
     */
    log(feature_name, "Detected button click; converting to results");

    if (!game.user.isGM) {
        // user isn't a GM, send a packet to the GM to do it instead
        game.socket.emit("module.ffg-star-wars-enhancements", {
            type: "dice",
            object: object,
        });
        return;
    }
    
    // Try to determine the correct content path
    let content = null;
    
    if (object?.message?.content) {
        content = object.message.content;
    } else if (object?.content) {
        content = object.content;
    } else if (object?.data?.content) {
        content = object.data.content;
    } else if (object?.toObject) {
        let objData = object.toObject();
        if (objData?.content) {
            content = objData.content;
        } else if (objData?.message?.content) {
            content = objData.message.content;
        }
    }
    
    if (!content) {
        return;
    }
    
    var data = determine_data(content);
    log(feature_name, JSON.stringify(data));

    let skill = data["skill"];
    let result = await fetch_suggestions(data);

    // Get the actual ChatMessage document from the collection
    // Handle both cases: wrapper object with message property, or direct ChatMessage document
    let msg = null;
    let messageId = null;

    if (object?.message?._id) {
        // Wrapper object case (from socket or renderChatMessage wrapper)
        messageId = object.message._id;
        msg = game.messages.get(messageId);
    } else if (object?._id && object.constructor?.name === "ChatMessage") {
        // Direct ChatMessage document case
        messageId = object._id;
        msg = object; // Already have the document
    } else if (object?._id) {
        // Fallback: try to get by ID
        messageId = object._id;
        msg = game.messages.get(messageId);
    } else {
        return;
    }

    if (!msg) {
        return;
    }

    let context = {
        suggestions: result.suggestions,
        contextGroups: result.contextGroups,
        skill: skill,
    };
    let newContent = (await getTemplate("modules/ffg-star-wars-enhancements/templates/dice_helper.html"))(
        context
    );
    
    // Update only the content field
    await msg.update({ content: newContent });
    log(feature_name, "Updated the message");
}

function determine_data(incoming_data) {
    /**
     * read the button metadata to determine results from the associated dice roll
     *
     * @param {incoming_data} html created by dice_helper
     */
    let data = $(incoming_data);
    return {
        ad: data.data("ad"),
        tr: data.data("tr"),
        th: data.data("th"),
        de: data.data("de"),
        su: data.data("su"),
        fa: data.data("fa"),
        skill: data.data("sk"),
    };
}

async function fetch_suggestions(results) {
    // categories suggestions can exist for
    let suggestion_categories = ["su", "fa", "ad", "th", "tr", "de"];

    let skill = results["skill"].toLowerCase().replace(/&/g, "&amp;").replace(/\s+/g, " ").trim();
    let data = load_data();

    if (!is_supported_skill(skill, data)) {
        // we don't have any suggestions for this skill
        log(feature_name, "Not rendering suggestion; unable to find " + skill + " in " + JSON.stringify(data));
        return [];
    }

    // build out an array of the suggestions
    let suggestions = [];
    let contextGroupMap = {};
    let contextGroupOrder = [];
    for (var x = 0; x < suggestion_categories.length; x++) {
        let category = suggestion_categories[x];
        if (!data[skill][category] || !Array.isArray(data[skill][category])) {
            continue;
        }
        // build an array of the suggestions for the specific category we're looking at now
        if ((category === "ad" && results["tr"] > 0) || (category === "th" && results["de"] > 0)) {
            var tmp_suggestions = data[skill][category];
        } else {
            var tmp_suggestions = data[skill][category].filter(
                (suggestion) => suggestion.required <= results[category]
            );
        }

        // separate context vs non-context entries
        let nonContextSuggestions = tmp_suggestions.filter((s) => !s.context).sort((a, b) => a.required - b.required);
        let contextSuggestions = tmp_suggestions.filter((s) => s.context);

        // collect context entries across all categories, grouped by context name
        for (let s of contextSuggestions) {
            if (!contextGroupMap[s.context]) {
                contextGroupMap[s.context] = [];
                contextGroupOrder.push(s.context);
            }
            contextGroupMap[s.context].push({ text: s.text, required: s.required, category: category });
        }

        if (nonContextSuggestions.length > 0) {
            suggestions.push({
                category: category,
                suggestions: nonContextSuggestions,
            });
        }
    }

    // build combined context groups
    let contextGroups = contextGroupOrder.map((name) => ({ name: name, entries: contextGroupMap[name] }));

    return { suggestions, contextGroups };
}

function is_supported_skill(skill, data) {
    /**
     * read the button metadata to determine results from the associated dice roll
     *
     * @param {skill} string, lowercase, of the skill being checked for
     * @param {data} JSON blob with the result helpers (from load_data())
     * returns true/false
     */
    log(feature_name, "Checking if " + skill + " has any helpers");
    let result = skill in data;
    
    // Try case-insensitive check as fallback
    if (!result && data) {
        const lowerSkill = skill.toLowerCase();
        const matchingKey = Object.keys(data).find(key => key.toLowerCase() === lowerSkill);
        if (matchingKey) {
            // Update the data to use the correct key
            data[skill] = data[matchingKey];
            result = true;
        }
    }
    
    return result;
}

export function load_data() {
    /**
     * Load dice helper data from the Journal
     * Returns a dict in the format of:
     *  {
     *      'cool': {
     *          'su': [
     *              {
     *                  'text': 'pass the check',
     *                  'required': 1,
     *              },
     *              ...
     *          ],
     *          ...
     *      },
     *      ...
     *  }
     */
    let journal_name = game.settings.get("ffg-star-wars-enhancements", "dice-helper-data");

    // return cached data if available
    if (_cachedData && _cacheJournalName === journal_name) {
        log(feature_name, "Returning cached data for " + journal_name);
        return _cachedData;
    }

    let candidates = game.journal.filter((journal) => journal.name === journal_name);

    if (candidates.length <= 0) {
        ui.notifications.warn(
            `Dice helper: no journal named "${journal_name}" exists. Check the "dice helper data" module setting.`
        );
        log(feature_name, "Unable to find journal with the name " + journal_name);
        return {};
    }

    // importing a journal creates a new document rather than replacing an existing one, so several
    // entries can share the same name. Prefer one that actually holds pages over whichever sorts first.
    let journal = candidates.find((candidate) => candidate.pages.contents.length > 0);
    if (candidates.length > 1) {
        log(
            feature_name,
            `Found ${candidates.length} journals named ${journal_name}; using the first one that has pages`
        );
        ui.notifications.warn(
            `Dice helper: ${candidates.length} journals are named "${journal_name}". Delete the duplicates to avoid ambiguity.`
        );
    }

    if (journal === undefined) {
        ui.notifications.warn(
            `Dice helper: the journal "${journal_name}" has no pages. Delete it and reload to have it recreated.`
        );
        log(feature_name, "Unable to find journal with correct pages");
        return {};
    }
    log(feature_name, "Found journal " + journal_name);

    let journal_pages = journal.pages.contents;

    let jsondata = {};
    for (let page of journal_pages) {
        if (!page.text || !page.text.content) {
            continue;
        }
        try {
            let data = page.text.content.replace(/<\/?p>/g, "");
            let pageData = JSON.parse(data.replace(/\u201c|\u201d/g, '"'));
            // merge page data into combined result, expanding comma-separated keys
            Object.keys(pageData).forEach((key) => {
                let keys = key.split(",").map((k) => k.trim());
                for (let k of keys) {
                    if (jsondata[k]) {
                        // merge arrays for each category
                        for (let cat of ["su", "ad", "tr", "fa", "th", "de"]) {
                            if (pageData[key][cat]) {
                                if (!jsondata[k][cat]) {
                                    jsondata[k][cat] = [];
                                }
                                jsondata[k][cat] = jsondata[k][cat].concat(pageData[key][cat]);
                            }
                        }
                    } else {
                        jsondata[k] = JSON.parse(JSON.stringify(pageData[key]));
                    }
                }
            });
            log(feature_name, "Loaded data from page: " + page.name);
        } catch (err) {
            log(feature_name, "Skipping page '" + page.name + "': not valid dice helper JSON");
        }
    }

    if (Object.keys(jsondata).length === 0) {
        ui.notifications.warn("Dice helper: no valid data found in any journal page");
        return {};
    }

    // Translate skill names if possible
    Object.keys(jsondata).forEach((skillname) => {
        if (skillname.includes("SWFFG.")) {
            let localized = game.i18n.localize(skillname);
            let localizedskill = localized.toLowerCase().replace(/\s+/g, " ").trim();
            Object.defineProperty(jsondata, localizedskill, Object.getOwnPropertyDescriptor(jsondata, skillname));
            delete jsondata[skillname];
        }
    });

    _cachedData = jsondata;
    _cacheJournalName = journal_name;
    log(feature_name, "Cached data for " + journal_name);
    return jsondata;
}

async function default_page_data() {
    /**
     * Build the page holding the shipped dice helper suggestions, translated where we have a translation
     */
    // let's search for a translated one (will probably show an error in console, can't avoid it)
    let jsonFilePath = "modules/ffg-star-wars-enhancements/content/dice_helper_" + game.i18n.lang + ".json";
    let logFileStatus = "translated";
    await fetch(jsonFilePath).then((response) => {
        if (!response.ok) {
            logFileStatus = "default";
            jsonFilePath = "modules/ffg-star-wars-enhancements/content/dice_helper.json";
        }
    });

    log(feature_name, `using ${logFileStatus} dice helper content`);
    let suggestions = await $.getJSON(jsonFilePath);
    return {
        name: "dice_helper",
        type: "text",
        text: {
            content: JSON.stringify(suggestions),
            format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML,
        },
    };
}

export async function create_and_populate_journal() {
    // if the feature is not enabled, don't do anything
    log(feature_name, "checking status of journal");
    if (!game.settings.get("ffg-star-wars-enhancements", "dice-helper")) {
        return;
    }

    // only the GM may create world documents, and we only need one client to do this
    if (!game.user.isGM) {
        return;
    }

    // otherwise check to see if the journal already exists
    let journal_name = game.settings.get("ffg-star-wars-enhancements", "dice-helper-data");
    let candidates = game.journal.filter((journal) => journal.name === journal_name);

    // an entry with no pages holds no data, so it is no more usable than a missing one
    if (candidates.some((candidate) => candidate.pages.contents.length > 0)) {
        return;
    }

    let page = await default_page_data();

    if (candidates.length > 0) {
        // the journal exists but is empty - repair it rather than leaving the feature silently broken
        log(feature_name, "journal exists but has no pages, adding the default page");
        await candidates[0].createEmbeddedDocuments("JournalEntryPage", [page]);
        return;
    }

    // then create journal
    log(feature_name, "creating journal");
    await JournalEntry.create({
        name: journal_name,
        pages: [page],
        ownership: {
            default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER,
        },
    });
}
