# Read-only extensions

All tools stay read-only (`readOnlyHint: true`). New and changed tools:

| Tool | Purpose |
| --- | --- |
| GetTableContents | `fields`, `where`, `order_by`; output is compact JSON rows (`format: "xml"` for the raw ADT XML) |
| RunSelect | Free ABAP SQL `SELECT` (JOIN, COUNT, GROUP BY, subqueries, CDS) through the ADT data preview |
| GetSystemInfo | SID, host, client text/role, user, language, component releases |
| ListDumps / GetDump | ST22 runtime errors with filters (user, program, runtime error, exception, package, dates) and full dump text |
| GetWhereUsed | Where-used list of a repository object |
| GetVersionHistory / GetVersionSource / CompareVersions | Version management: history with transports, source of a version, unified diff |
| GetMessageText / GetDomainValues | T100 messages, domain fixed values with texts |
| RunAtcCheck | ATC findings for an object (SAP stores the run as a worklist; the object is not changed) |
| ListTraces / GetTraceDetails | ABAP traces (hit list, DB accesses, call tree) |

## Environment variables (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `SAP_TABLE_DENYLIST` | `USR02,USH02,USH02_ARC_TMP,USRPWDHISTORY,RFCDES,RSECTAB,RSECACTB,SSF_PSE_D` | Tables never read by GetTableContents/RunSelect (also in JOINs and subqueries). Comma separated, `*` wildcard. Setting it replaces the default; `-` disables it. |
| `SAP_AUDIT_LOG` | `<install>/logs/audit.jsonl` | JSON Lines audit of every tool call (time, host, client, user, tool, arguments, ok/error, duration). No passwords, no result data. `off` disables. |

## Authorizations

Besides the existing ADT read role, the new tools may need:

- RunSelect / GetTableContents: `S_TABU_DIS` / `S_TABU_NAM` for the tables read.
- ListDumps / GetDump: `S_ADMI_FCD` (ST22 / `ST0R`).
- RunAtcCheck: ATC authorizations (`S_Q_GOVERN`, `S_DEVELOP` display).
- Traces: `S_ADMI_FCD` (`ST0M`/`ST0R`) and `S_DEVELOP` display.

A 403 answer names SU53 / STAUTHTRACE in the error message.
