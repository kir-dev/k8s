## Documentation specification

The specification is written in accordance with [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119.txt).

You MUST update the documentation whenever anything changes.

All project documentation defined below MUST be located in the `k8s` repository. Each project MUST have a folder named after the project in `kebab-case` (e.g., `pek-infinity`). If there are multiple variants or components of the same project, they MUST be distinguished using hyphens in the folder name, still in `kebab-case` (e.g., `<project-name>-<variant>`, such as `pek-v4` or `pek-v4-backend`).

Each project folder MUST contain an `app.ts` file. The folder SHOULD contain Markdown files (ending in `.md`) where the bulk of the documentation is written, and you MAY add any supplementary materials as you see fit. You MAY structure your documentation however you like using subfolders. If the documentation includes any images, they MUST be uploaded to [Warp](https://warp.sch.bme.hu) and referenced from there (they MUST NOT be committed directly to the repository).

In terms of project ownership and personal information:
- Each project MUST specify its **maintainer** (the person responsible for the project).
- Personal information (e.g., personal email addresses, phone numbers, or other private contact details) MUST NOT be stored in the repository; all personal information MUST be placed on the [Simonyi Wiki](https://wiki.simonyi.bme.hu) instead, and you SHOULD link to the relevant Simonyi Wiki page.

In terms of the project's deployment documentation:
- It MUST contain the public URL(s) of the deployed project (e.g., `kir-dev.hu`).
- It MUST list what services are used.
- It MUST specify where the project is currently running, and you SHOULD add hyperlinks to the current deployment setup.
- It MUST specify where the running configuration files are located, or you MUST add hyperlinks to their locations. If the project uses a GUI-based platform (e.g., Vercel), you SHOULD add hyperlinks to the platform's settings.
- It MUST contain step-by-step deployment instructions for the project.
  - The instructions SHOULD include project-specific terminal commands.
- If the project is not deployed by Kir-Dev, it MUST contain the name of the hosting organization and the name(s) of the person(s) responsible for the deployment. Any personal contact information (e.g., email, phone) MUST be stored on the Simonyi Wiki rather than in the repository, and you SHOULD link to the relevant Simonyi Wiki page.

In terms of the project's update/upgrade documentation:
- It MUST contain known incompatibilities with detailed descriptions (e.g., if the project does not run on a newer version of Node.js).
- It MUST document deliberate version pins (e.g., if the project only works with Node.js 22.10.x).
- It SHOULD specify the order of operations for updates/upgrades (i.e., in what order the project's components should be updated).

An example can be found in [k8s/example-k8s](https://github.com/kir-dev/k8s/tree/main/example-k8s).
