# Separate local QA instances

Each checkout can run its own local lab while another checkout's lab stays running. The default remains `credentialdomd-qa-lab` on the template's ports.

Before starting a second checkout's lab, save this checkout's selection at `qa-lab/.generated/instance.json` (gitignored):

```json
{
  "name": "operational",
  "ports": {
    "api": 55421,
    "database": 55422,
    "shadow": 55420,
    "studio": 55423,
    "mail": 55424,
    "inspector": 8183
  }
}
```

This selects project/container/network/volume names ending in `credentialdomd-qa-lab-operational`. Choose unused, distinct ports from 1024 through 65535; all six fields are required. Names use lowercase letters, digits and single hyphens, begin with a letter, and have at most 32 characters. Hostnames cannot be configured: public services stay on loopback, and SQL hooks target this instance's Docker gateway. The normal loopback and checkout ownership checks remain enforced.

Run the usual `npm run qa:lab` and `npm run qa:e2e` commands from this checkout. The mock, app and cross-origin proxy each select an available local port and persist it in this checkout's `lab-ports.json`. `npm run qa:down` stops only this checkout's selected instance. Keep `instance.json` unchanged while the instance exists; do not use `QA_LAB_TAKE_OVER` for parallel work.

A saved production catalog can be reused without a new production read. Copy only `catalog.json` into this checkout's `.generated/`, then run:

```sh
node qa-lab/extract-schema.mjs --offline
```

That creates this checkout's own dummy vault values and rewrites SQL hooks to its selected gateway. Do not copy another lab's `schema.sql`, keys, dummy vault values, runtime, ports, mock state or generated stack directory. Schema application refuses a foreign gateway; a named instance also refuses a `QA_LAB_DB_URL` pointing at a different database port.

Changing or deleting the selection while a generated stack/runtime names a different instance is refused. Restore its original selection to stop it, or use another clean checkout for another running instance. There is no environment-only instance switch, so subprocesses and later cleanup commands consistently select the persisted instance.
