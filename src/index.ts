#!/usr/bin/env node
import {
  McpServer,
  fromJsonSchema,
  type CallToolResult,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import path from "path";
import dotenv from "dotenv";

// Import handler functions
import { handleGetProgram } from "./handlers/handleGetProgram";
import { handleGetClass } from "./handlers/handleGetClass";
import { handleGetFunctionGroup } from "./handlers/handleGetFunctionGroup";
import { handleGetFunction } from "./handlers/handleGetFunction";
import { handleGetTable } from "./handlers/handleGetTable";
import { handleGetStructure } from "./handlers/handleGetStructure";
import { handleGetTableContents } from "./handlers/handleGetTableContents";
import { handleGetPackage } from "./handlers/handleGetPackage";
import { handleGetInclude } from "./handlers/handleGetInclude";
import { handleGetTypeInfo } from "./handlers/handleGetTypeInfo";
import { handleGetInterface } from "./handlers/handleGetInterface";
import { handleGetTransaction } from "./handlers/handleGetTransaction";
import { handleSearchObject } from "./handlers/handleSearchObject";
import { handleGetCDSView } from "./handlers/handleGetCDSView";
import { handleGetBehaviorDefinition } from "./handlers/handleGetBehaviorDefinition";
import { handleGetServiceDefinition } from "./handlers/handleGetServiceDefinition";
import { handleRunSelect } from "./handlers/handleRunSelect";
import { handleGetSystemInfo } from "./handlers/handleGetSystemInfo";
import { handleListDumps, handleGetDump } from "./handlers/handleDumps";
import { handleGetWhereUsed } from "./handlers/handleWhereUsed";
import {
  handleGetVersionHistory,
  handleGetVersionSource,
  handleCompareVersions,
} from "./handlers/handleVersions";
import {
  handleGetMessageText,
  handleGetDomainValues,
} from "./handlers/handleTexts";
import { handleRunAtcCheck } from "./handlers/handleAtc";
import {
  handleListTraces,
  handleGetTraceDetails,
} from "./handlers/handleTraces";
import { writeAudit } from "./lib/audit";
import { OBJECT_TYPES, SOURCE_TYPES, CLASS_INCLUDES } from "./lib/objects";

// Import shared utility functions and types
import { MAX_PAGE_LINES, cleanup } from "./lib/utils";
import { withRequestSignal } from "./lib/network";

export { getConfig } from "./config";
export type { SapConfig } from "./config";

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// Shared schema fragments for every tool whose textual result is protected by
// the response byte cap. Runtime validation in lib/utils.ts matches these bounds.
export const PAGING_START_LINE = {
  type: "integer",
  minimum: 1,
  description:
    "1-based line number to start from (default 1). Beyond EOF returns an empty page with hasMore=false.",
};
export const PAGING_MAX_LINES = {
  type: "integer",
  minimum: 1,
  maximum: MAX_PAGE_LINES,
  description: `Maximum lines to return (1-${MAX_PAGE_LINES}). Omit to request the rest; the byte cap may return fewer lines.`,
};

export const PAGED_TEXT_TOOL_NAMES = [
  "GetProgram",
  "GetClass",
  "GetFunctionGroup",
  "GetFunction",
  "GetStructure",
  "GetTable",
  "GetTableContents",
  "GetPackage",
  "GetTypeInfo",
  "GetInclude",
  "SearchObject",
  "GetTransaction",
  "GetCDSView",
  "GetInterface",
  "GetBehaviorDefinition",
  "GetServiceDefinition",
  "RunSelect",
  "GetSystemInfo",
  "ListDumps",
  "GetDump",
  "GetWhereUsed",
  "GetVersionHistory",
  "GetVersionSource",
  "CompareVersions",
  "GetMessageText",
  "GetDomainValues",
  "RunAtcCheck",
  "ListTraces",
  "GetTraceDetails",
] as const;

const PAGED_TEXT_TOOL_SET = new Set<string>(PAGED_TEXT_TOOL_NAMES);

export function addPagingSchemas(tools: any[]) {
  return tools.map((tool) => {
    if (!PAGED_TEXT_TOOL_SET.has(tool.name)) {
      return tool;
    }
    return {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...tool.inputSchema.properties,
          startLine: PAGING_START_LINE,
          maxLines: PAGING_MAX_LINES,
        },
      },
    };
  });
}

const TOOL_DEFINITIONS = [
  // Define available tools
  {
    name: "GetProgram",
    description:
      "Retrieve ABAP program source code. For large programs, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        program_name: {
          type: "string",
          description: "Name of the ABAP program",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["program_name"],
    },
  },
  {
    name: "GetClass",
    description:
      "Retrieve ABAP class source code. For large classes, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        class_name: {
          type: "string",
          description: "Name of the ABAP class",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["class_name"],
    },
  },
  {
    name: "GetFunctionGroup",
    description:
      "Retrieve ABAP Function Group source code. For large function groups, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        function_group: {
          type: "string",
          description: "Name of the function module",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["function_group"],
    },
  },
  {
    name: "GetFunction",
    description:
      "Retrieve ABAP Function Module source code. For large function modules, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        function_name: {
          type: "string",
          description: "Name of the function module",
        },
        function_group: {
          type: "string",
          description: "Name of the function group",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["function_name", "function_group"],
    },
  },
  {
    name: "GetStructure",
    description:
      "Retrieve ABAP Structure. For large structures, use startLine/maxLines to page through the result instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        structure_name: {
          type: "string",
          description: "Name of the ABAP Structure",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["structure_name"],
    },
  },
  {
    name: "GetTable",
    description:
      "Retrieve ABAP table structure. For large tables, use startLine/maxLines to page through the result instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        table_name: {
          type: "string",
          description: "Name of the ABAP table",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["table_name"],
    },
  },
  {
    name: "GetTableContents",
    description:
      "Retrieve contents of an ABAP table or view (read-only ADT data preview). Optional fields, where and order_by build an ABAP SQL SELECT, e.g. where: \"BUKRS = '1000' AND GJAHR = '2026'\". Use ABAP SQL syntax with literals in single quotes and internal formats (leading zeros, YYYYMMDD dates). max_rows limits SAP rows; startLine/maxLines page the returned textual XML when its serialized size is still large.",
    inputSchema: {
      type: "object",
      properties: {
        table_name: {
          type: "string",
          description: "Name of the ABAP table",
        },
        fields: {
          type: "array",
          items: { type: "string" },
          description:
            'Optional columns to return (default all), e.g. ["BUKRS", "BELNR", "GJAHR"]',
        },
        where: {
          type: "string",
          description:
            "Optional ABAP SQL condition without the WHERE keyword, e.g. MATNR = '000000000000001234' AND WERKS LIKE 'C%'",
        },
        order_by: {
          type: "string",
          description: 'Optional ORDER BY list, e.g. "ERDAT DESCENDING, VBELN"',
        },
        format: {
          type: "string",
          enum: ["json", "xml"],
          description:
            "json (default): compact rows, one JSON object per line. xml: raw ADT data preview XML.",
        },
        max_rows: {
          type: "number",
          description: "Maximum number of rows to retrieve",
          default: 100,
        },
      },
      required: ["table_name"],
    },
  },
  {
    name: "GetPackage",
    description:
      "Retrieve ABAP package details. Use startLine/maxLines to page large serialized package listings.",
    inputSchema: {
      type: "object",
      properties: {
        package_name: {
          type: "string",
          description: "Name of the ABAP package",
        },
      },
      required: ["package_name"],
    },
  },
  {
    name: "GetTypeInfo",
    description:
      "Retrieve ABAP type information. For large results, use startLine/maxLines to page through it instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        type_name: {
          type: "string",
          description: "Name of the ABAP type",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["type_name"],
    },
  },
  {
    name: "GetInclude",
    description:
      "Retrieve ABAP Include Source Code. For large includes, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        include_name: {
          type: "string",
          description: "Name of the ABAP Include",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["include_name"],
    },
  },
  {
    name: "SearchObject",
    description:
      "Search for ABAP objects using quick search. maxResults limits matches; startLine/maxLines page the returned textual XML when its serialized size is still large.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query string (use * wildcard for partial match)",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of results to return",
          default: 100,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "GetTransaction",
    description:
      "Retrieve ABAP transaction details. For large results, use startLine/maxLines to page through it instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        transaction_name: {
          type: "string",
          description: "Name of the ABAP transaction",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["transaction_name"],
    },
  },
  {
    name: "GetCDSView",
    description:
      "Retrieve CDS view (DDL source) source code. For large views, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        cds_view_name: {
          type: "string",
          description:
            "Name of the CDS view (DDL source name, e.g. I_CURRENCY)",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["cds_view_name"],
    },
  },
  {
    name: "GetInterface",
    description:
      "Retrieve ABAP interface source code. For large interfaces, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        interface_name: {
          type: "string",
          description: "Name of the ABAP interface",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["interface_name"],
    },
  },
  {
    name: "GetBehaviorDefinition",
    description:
      "Retrieve RAP Behavior Definition (BDEF) source code (requires ~NW 7.54 / S/4HANA). For large definitions, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        behavior_definition_name: {
          type: "string",
          description: "Name of the RAP Behavior Definition (e.g. I_MY_ENTITY)",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["behavior_definition_name"],
    },
  },
  {
    name: "GetServiceDefinition",
    description:
      "Retrieve RAP Service Definition (SRVD) source code (requires ~NW 7.54 / S/4HANA). For large definitions, use startLine/maxLines to page through the source instead of retrieving it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        service_definition_name: {
          type: "string",
          description: "Name of the RAP Service Definition (e.g. Z_MY_SERVICE)",
        },
        startLine: PAGING_START_LINE,
        maxLines: PAGING_MAX_LINES,
      },
      required: ["service_definition_name"],
    },
  },
];

const OBJECT_ARGS = {
  object_type: {
    type: "string",
    enum: [...OBJECT_TYPES],
    description:
      "Repository object type: PROG program, INCL include, CLAS class, INTF interface, FUGR function group, FUNC function module, TABL table, STRU structure, VIEW DDIC view, DTEL data element, DOMA domain, TTYP table type, DDLS CDS view, BDEF behavior definition, SRVD service definition, MSAG message class, TRAN transaction",
  },
  object_name: { type: "string", description: "Object name, e.g. ZMY_REPORT" },
  function_group: {
    type: "string",
    description: "Function group (required when object_type is FUNC)",
  },
};

const SOURCE_ARGS = {
  ...OBJECT_ARGS,
  object_type: {
    type: "string",
    enum: [...SOURCE_TYPES],
    description:
      "Source object type: PROG, INCL, CLAS, INTF, FUNC (needs function_group), DDLS, BDEF, SRVD",
  },
  include: {
    type: "string",
    enum: [...CLASS_INCLUDES],
    description: "Class include for CLAS (default main)",
  },
};

const LANGUAGE_ARG = {
  type: "string",
  description:
    "Language as SAP key (S, E) or ISO code (ES, EN); '*' for all languages. Default SAP_LANGUAGE or all.",
};

const EXTRA_TOOLS = [
  {
    name: "RunSelect",
    description:
      "Run a read-only ABAP SQL SELECT through the ADT data preview (same as Eclipse SQL console): JOINs, aggregates (COUNT, SUM), GROUP BY, subqueries and CDS views are allowed. One statement only, no INTO/UP TO, no comments, no ';' or '.'. Tables in the denylist (SAP_TABLE_DENYLIST) are blocked. Example: SELECT vbeln, COUNT(*) AS items FROM vbap WHERE erdat >= '20260101' GROUP BY vbeln",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          maxLength: 8000,
          description: "ABAP SQL SELECT statement",
        },
        max_rows: {
          type: "number",
          description: "Maximum number of rows (default 100)",
          default: 100,
        },
        format: {
          type: "string",
          enum: ["json", "xml"],
          description: "json (default) compact rows or raw xml",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "GetSystemInfo",
    description:
      "Show which SAP system this connection reaches: system ID, host, client (text and role: production/test/customizing), technical user, language and software component releases (SAP_BASIS, S4CORE). Use it to confirm the target before analysing data.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ListDumps",
    description:
      "List ABAP runtime errors (ST22) with filters and a compact summary per dump (runtime error, exception, program, user, date, short text). Use include_details for the 'what happened / error analysis / where terminated' summary. Then GetDump for the full text.",
    inputSchema: {
      type: "object",
      properties: {
        user: { type: "string", description: "User who caused the dump" },
        program: {
          type: "string",
          description: "Program/object name (contains match)",
        },
        runtime_error: {
          type: "string",
          description: "Runtime error, e.g. CONVT_NO_NUMBER",
        },
        exception: {
          type: "string",
          description: "Exception class, e.g. CX_SY_ZERODIVIDE",
        },
        package: {
          type: "string",
          description: "Package of the terminated object",
        },
        from_date: {
          type: "string",
          description: "From date YYYYMMDD or YYYY-MM-DD",
        },
        to_date: {
          type: "string",
          description: "To date YYYYMMDD or YYYY-MM-DD",
        },
        include_details: {
          type: "boolean",
          description: "Add the textual dump summary to each entry",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Maximum dumps to return (default 20)",
        },
      },
    },
  },
  {
    name: "GetDump",
    description:
      "Full text of one ABAP runtime error (ST22), by the id returned by ListDumps. Large: page with startLine/maxLines.",
    inputSchema: {
      type: "object",
      properties: {
        dump_id: { type: "string", description: "Dump id from ListDumps" },
      },
      required: ["dump_id"],
    },
  },
  {
    name: "GetWhereUsed",
    description:
      "Where-used list of a repository object (programs, classes, methods, function modules, CDS views that use it), with package and usage kind.",
    inputSchema: {
      type: "object",
      properties: {
        ...OBJECT_ARGS,
        only_custom: {
          type: "boolean",
          description: "Only Z*/Y*/customer namespace users",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 2000,
          description: "Maximum results (default 200)",
        },
      },
      required: ["object_type", "object_name"],
    },
  },
  {
    name: "GetVersionHistory",
    description:
      "Version history (SE38/SE24 'versions') of a source object: date, author, transport request and version_uri for GetVersionSource/CompareVersions. Newest first.",
    inputSchema: {
      type: "object",
      properties: SOURCE_ARGS,
      required: ["object_type", "object_name"],
    },
  },
  {
    name: "GetVersionSource",
    description:
      "Source code of a stored version, by a version_uri returned by GetVersionHistory.",
    inputSchema: {
      type: "object",
      properties: {
        version_uri: {
          type: "string",
          description: "Version URI from GetVersionHistory",
        },
      },
      required: ["version_uri"],
    },
  },
  {
    name: "CompareVersions",
    description:
      "Unified diff between two versions of a source object. Default: newest stored version vs the active source. Set from_version_uri / to_version_uri to compare specific versions.",
    inputSchema: {
      type: "object",
      properties: {
        ...SOURCE_ARGS,
        from_version_uri: {
          type: "string",
          description: "Older version (default newest stored version)",
        },
        to_version_uri: {
          type: "string",
          description: "Newer version (default active source)",
        },
        context_lines: {
          type: "integer",
          minimum: 0,
          maximum: 50,
          description: "Context lines around changes (default 3)",
        },
      },
      required: ["object_type", "object_name"],
    },
  },
  {
    name: "GetMessageText",
    description:
      "Message texts (SE91 / table T100) of a message class, optionally one number. Useful to explain messages like 'ZFI 012'.",
    inputSchema: {
      type: "object",
      properties: {
        message_class: {
          type: "string",
          description: "Message class, e.g. ZFI or V1",
        },
        message_number: {
          type: "string",
          description: "Message number 000-999",
        },
        language: LANGUAGE_ARG,
      },
      required: ["message_class"],
    },
  },
  {
    name: "GetDomainValues",
    description:
      "Fixed values of a domain with their texts (DD07L/DD07T), or its value table when there are no fixed values.",
    inputSchema: {
      type: "object",
      properties: {
        domain_name: { type: "string", description: "Domain, e.g. BU_TYPE" },
        language: LANGUAGE_ARG,
      },
      required: ["domain_name"],
    },
  },
  {
    name: "RunAtcCheck",
    description:
      "Run ATC (code inspector) on an object with the system or given check variant and return the findings by priority, check, message and line. Does not change the object; SAP keeps the run as an ATC worklist.",
    inputSchema: {
      type: "object",
      properties: {
        ...OBJECT_ARGS,
        check_variant: {
          type: "string",
          description: "ATC check variant (default: system variant)",
        },
        include_exempted: {
          type: "boolean",
          description: "Include exempted findings",
        },
        max_findings: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          description: "Maximum findings (default 100)",
        },
      },
      required: ["object_type", "object_name"],
    },
  },
  {
    name: "ListTraces",
    description:
      "List ABAP runtime traces (SAT / ADT profiler) of a user (default: the connection user) with their ids.",
    inputSchema: {
      type: "object",
      properties: {
        user: {
          type: "string",
          description: "Trace owner (default connection user)",
        },
      },
    },
  },
  {
    name: "GetTraceDetails",
    description:
      "Read an ABAP trace: hitlist (where time is spent), dbaccess (SQL statements per table, like an SQL trace summary) or statements (call tree).",
    inputSchema: {
      type: "object",
      properties: {
        trace_id: { type: "string", description: "Trace id from ListTraces" },
        view: {
          type: "string",
          enum: ["hitlist", "dbaccess", "statements"],
          description: "Default hitlist",
        },
        with_system_events: {
          type: "boolean",
          description: "Include system events",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 5000,
          description: "Maximum entries (default 200)",
        },
      },
      required: ["trace_id"],
    },
  },
];

const HANDLERS: Record<string, (args: any) => Promise<any>> = {
  GetProgram: handleGetProgram,
  GetClass: handleGetClass,
  GetFunction: handleGetFunction,
  GetFunctionGroup: handleGetFunctionGroup,
  GetStructure: handleGetStructure,
  GetTable: handleGetTable,
  GetTableContents: handleGetTableContents,
  GetPackage: handleGetPackage,
  GetTypeInfo: handleGetTypeInfo,
  GetInclude: handleGetInclude,
  SearchObject: handleSearchObject,
  GetInterface: handleGetInterface,
  GetTransaction: handleGetTransaction,
  GetCDSView: handleGetCDSView,
  GetBehaviorDefinition: handleGetBehaviorDefinition,
  GetServiceDefinition: handleGetServiceDefinition,
  RunSelect: handleRunSelect,
  GetSystemInfo: handleGetSystemInfo,
  ListDumps: handleListDumps,
  GetDump: handleGetDump,
  GetWhereUsed: handleGetWhereUsed,
  GetVersionHistory: handleGetVersionHistory,
  GetVersionSource: handleGetVersionSource,
  CompareVersions: handleCompareVersions,
  GetMessageText: handleGetMessageText,
  GetDomainValues: handleGetDomainValues,
  RunAtcCheck: handleRunAtcCheck,
  ListTraces: handleListTraces,
  GetTraceDetails: handleGetTraceDetails,
};

export function createServer(): McpServer {
  const server = new McpServer({
    name: "mcp-abap-adt",
    version: require("../package.json").version,
  });
  for (const tool of addPagingSchemas([...TOOL_DEFINITIONS, ...EXTRA_TOOLS])) {
    const properties = tool.inputSchema.properties;
    for (const value of Object.values(properties) as any[]) {
      if (value.type === "string") {
        value.minLength = 1;
        value.maxLength ??= 1024;
      }
    }
    for (const name of ["max_rows", "maxResults"]) {
      if (properties[name])
        Object.assign(properties[name], {
          type: "integer",
          minimum: 1,
          maximum: 10000,
        });
    }
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>({
          ...tool.inputSchema,
          additionalProperties: false,
        }),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args, ctx) =>
        withRequestSignal(ctx.mcpReq.signal, async () => {
          const started = Date.now();
          const result = await HANDLERS[tool.name](args);
          writeAudit(tool.name, args, result, Date.now() - started);
          return result as CallToolResult;
        }),
    );
  }
  return server;
}

export class mcp_abap_adt_server {
  async run() {
    const handle = serveStdio(() => createServer());
    const stop = async () => {
      await handle.close();
      cleanup();
    };
    process.once("SIGINT", () => {
      void stop();
    });
    process.once("SIGTERM", () => {
      void stop();
    });
    process.stdin.once("end", cleanup);
  }
}

if (require.main === module) {
  new mcp_abap_adt_server().run().catch(() => {
    console.error("Unable to start mcp-abap-adt");
    process.exitCode = 1;
  });
}
