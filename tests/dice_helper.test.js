import { create_and_populate_journal, invalidate_cache, load_data } from "../scripts/dice_helper.js";

const JOURNAL_NAME = "quench_dice_helper";
const SAMPLE = { cool: { su: [{ text: "quench sample", required: 1 }] } };

async function delete_test_journals() {
    const existing = game.journal.filter((journal) => journal.name === JOURNAL_NAME);
    for (const journal of existing) {
        await journal.delete();
    }
}

async function create_journal(pages) {
    return await JournalEntry.create({ name: JOURNAL_NAME, pages: pages });
}

function sample_page() {
    return {
        name: "dice_helper",
        type: "text",
        text: {
            content: JSON.stringify(SAMPLE),
            format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML,
        },
    };
}

export function batch(context) {
    const { describe, it, before, beforeEach, after, afterEach, expect } = context;

    describe("Dice helper journal resolution", function () {
        this.timeout(60000);
        let original_journal_name;

        before(async () => {
            original_journal_name = game.settings.get("ffg-star-wars-enhancements", "dice-helper-data");
            await game.settings.set("ffg-star-wars-enhancements", "dice-helper-data", JOURNAL_NAME);
        });

        after(async () => {
            await delete_test_journals();
            await game.settings.set("ffg-star-wars-enhancements", "dice-helper-data", original_journal_name);
        });

        beforeEach(async () => {
            await delete_test_journals();
            invalidate_cache();
        });

        afterEach(async () => {
            await delete_test_journals();
            invalidate_cache();
        });

        it("creates the journal when none exists", async () => {
            await create_and_populate_journal();

            const journals = game.journal.filter((journal) => journal.name === JOURNAL_NAME);
            expect(journals.length).to.equal(1);
            expect(journals[0].pages.contents.length).to.be.greaterThan(0);
        });

        it("adds the default page to a journal that exists but is empty", async () => {
            const empty = await create_journal([]);
            expect(empty.pages.contents.length).to.equal(0);

            await create_and_populate_journal();

            const journals = game.journal.filter((journal) => journal.name === JOURNAL_NAME);
            // the existing entry is repaired rather than a second one being created
            expect(journals.length).to.equal(1);
            expect(journals[0].id).to.equal(empty.id);
            expect(journals[0].pages.contents.length).to.be.greaterThan(0);
        });

        it("leaves an already populated journal alone", async () => {
            const populated = await create_journal([sample_page()]);

            await create_and_populate_journal();

            const journals = game.journal.filter((journal) => journal.name === JOURNAL_NAME);
            expect(journals.length).to.equal(1);
            expect(journals[0].pages.contents.length).to.equal(1);
            expect(journals[0].id).to.equal(populated.id);
        });

        it("reads the populated journal when an empty duplicate sorts first", async () => {
            // importing a journal creates a second document with the same name rather than replacing
            await create_journal([]);
            await create_journal([sample_page()]);

            const data = load_data();

            expect(data).to.have.property("cool");
            expect(data.cool.su[0].text).to.equal("quench sample");
        });

        it("returns no data when every journal with the configured name is empty", async () => {
            await create_journal([]);

            expect(load_data()).to.deep.equal({});
        });
    });

    describe("Dice helper cache invalidation", function () {
        this.timeout(60000);
        let original_journal_name;

        before(async () => {
            original_journal_name = game.settings.get("ffg-star-wars-enhancements", "dice-helper-data");
            await game.settings.set("ffg-star-wars-enhancements", "dice-helper-data", JOURNAL_NAME);
        });

        after(async () => {
            await delete_test_journals();
            await game.settings.set("ffg-star-wars-enhancements", "dice-helper-data", original_journal_name);
        });

        beforeEach(async () => {
            await delete_test_journals();
            invalidate_cache();
        });

        afterEach(async () => {
            await delete_test_journals();
            invalidate_cache();
        });

        it("picks up a journal imported after a failed read", async () => {
            // a failed read must not be cached, otherwise importing the data never takes effect
            expect(load_data()).to.deep.equal({});

            await create_journal([sample_page()]);

            expect(load_data()).to.have.property("cool");
        });

        it("picks up pages created alongside their parent entry", async () => {
            await create_journal([sample_page()]);
            expect(load_data()).to.have.property("cool");

            await delete_test_journals();
            // an import creates the entry and its pages in one operation, which fires no page hooks
            await create_journal([
                {
                    name: "dice_helper",
                    type: "text",
                    text: {
                        content: JSON.stringify({ vigilance: { su: [{ text: "reimported", required: 1 }] } }),
                        format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML,
                    },
                },
            ]);

            const data = load_data();
            expect(data).to.have.property("vigilance");
            expect(data).to.not.have.property("cool");
        });

        it("drops cached data when the configured journal name changes", async () => {
            await create_journal([sample_page()]);
            expect(load_data()).to.have.property("cool");

            // round-tripping the setting must not hand back the stale cache
            await game.settings.set("ffg-star-wars-enhancements", "dice-helper-data", JOURNAL_NAME + "_other");
            expect(load_data()).to.deep.equal({});

            await game.settings.set("ffg-star-wars-enhancements", "dice-helper-data", JOURNAL_NAME);
            expect(load_data()).to.have.property("cool");
        });
    });
}
