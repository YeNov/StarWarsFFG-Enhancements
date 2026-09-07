import { batch as datapad_batch } from "./datapads.test.js";
import { batch as dice_helper_batch } from "./dice_helper.test.js";

function registerQuenchTests(quench) {
    quench.registerBatch("ffg-star-wars-enhancements.datapads", datapad_batch);
    quench.registerBatch("ffg-star-wars-enhancements.dice_helper", dice_helper_batch);
}

export function init() {
    // Use Quench's ready hook to add our tests. This hook will never be triggered if Quench isn't loaded.
    Hooks.on("quenchReady", registerQuenchTests);
}
