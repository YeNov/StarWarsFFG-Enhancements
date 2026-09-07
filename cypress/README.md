# Cypress Tests

The FFG Star Wars Enhancements module uses [Cypress](https://www.cypress.io/) to run its tests.

## Overview

Cypress automates front end testing by emulating user interactions within a browser.

## Testing locally

> :warning: Cypress tests run against FoundryVTT's default port of 30001 by default. The tests take actions that may be harmful to any real games running in that environment. See Configuration below to change the default.

Cypress itself does not orchestrate launching FoundryVTT. By default, it expects a fresh FoundryVTT instance to be running on `http://localhost:30001`.

To run Cypress [headless](https://en.wikipedia.org/wiki/Headless_browser) from the commandline:

```shell
# Install dependencies
npm install

# Run Cypress
npx cypress run
```

## Testing locally

Running Cypress in its interactive mode can simplify troubleshooting or developing new tests.

There are a number of ways to [launch Cypress](https://docs.cypress.io/guides/getting-started/opening-the-app) interactively.
(Note: When testing interactively, keep the window in focus or use Chrome devtools to emulate a focused page. See [#158](https://github.com/wrycu/StarWarsFFG-Enhancements/issues/158).)

If you're developing in the same environment as the code base with no virtualization/container layers, try `npx cypress open`.
Otherwise, [install Cypress](https://docs.cypress.io/guides/getting-started/installing-cypress) manually.

Once Cypress is open:

1. Add the project
2. Select "E2E Testing"
3. Select "Start E2E Testing in Chrome" (or the browser of your choice), which launches the browser
4. Select the test to run (`*.cy.js` file) - :warning: the test is immediately run

### Configuration

The default Cypress configuration can be customized by creating a `cypress.env.json` in the project root. For example, to change the instance of FoundryVTT being tested to another port, populate the file with:

```json
{
    "baseUrl": "http://localhost:8080"
}
```

### Docker Compose

To test FoundryVTT with Docker, use the `felddy/foundryvtt` docker image. This is what our GitHub Actions use.
To make this simpler, a `docker-compose.yaml` has been included in the root of this repository. It can be used to setup/tear-down FoundryVTT for quick testing.

```shell

# Copy the secrets distribution file and populate it with your foundryvtt.com credentials and license key
cp secrets.json.dist secrets.json

# Launch FoundryVTT
docker compose up -d

# Attach to monitor logs; detach with ctrl-p ctrl-q
docker attach foundryvtt

# Teardown FoundryVTT
docker compose down
```

To override the `docker-compose.yaml` defaults create a [docker-compose.override.yaml](https://docs.docker.com/compose/extends/).

```yaml
services:
    foundry-test:
        # See https://github.com/felddy/foundryvtt-docker for other environment variables
        environment:
            # Change the UID/GID to match your development environment to avoid FoundryVTT overwriting permissions
            - FOUNDRY_UID=1000
            - FOUNDRY_GID=1000

        # Remind port mapping
        ports:
            - target: 30000
              published: 8080
              protocol: tcp
```

## Continuous integration

This fork does not run the Cypress tests in CI. The workflow that did (`.github/workflows/cypress.yaml`) required
`FOUNDRY_USERNAME`, `FOUNDRY_PASSWORD` and `FOUNDRY_LICENSE_KEY` repository secrets holding a FoundryVTT account, which
this fork does not have, so it failed within seconds on every pull request. It was removed rather than left permanently
red.

Run the suite locally as described above. To restore CI, recover the workflows from git history
(`git log --diff-filter=D -- .github/workflows/cypress.yaml`) and configure the three secrets, plus a `requires-approval`
environment with reviewers — the workflow used `pull_request_target`, so without that gate a pull request from any fork
could read those credentials.
