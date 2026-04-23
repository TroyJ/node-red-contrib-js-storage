/**
 * Convert each node JSON in Node-RED flows file to/from individual JS files in CommonJS
 *
 * A. json2js converts json to js:
 *   1. Export JSON without multiline and function strings as const Node = ...
 *   2. Extract multiline strings as template literals e.g. Node.info = ... (attributes: info, template)
 *   3. Extract function strings as javascript functions e.g. Node.func = ... (attributes: initialize, func, finalize)
 *
 * B. js2json converts the js back to json
 *
 * See test file for an example
 **/

const fs = require("fs-extra");
const fspath = require("path");
const vm = require("vm");

const storageExtension = ".flows.js";
const logPrefix = "node-red-contrib-js-storage: ";
const tabOrderFileName = "_tab-order.txt";

const nodePrefix = `const Node = `;
const nodeSuffix = `module.exports = Node;`;
const funcIndent = "  ";
const funcParameters = [
  "node",
  "msg",
  "RED",
  "context",
  "flow",
  "global",
  "env",
  "util",
];
const funcPrefix = (name, params) =>
  `Node.${name} = async function (${params.join(", ")}) {`;
const funcSuffix = "}";
const textPrefix = (name) => `Node.${name} = ` + "`\n";
const textSuffix = "\n`";

// textEscapes are characters that must be escaped in a template literal
const textEscapes = {
  "`": "\\`",
  "\\": "\\\\",
  $: "\\$",
};

// Lazy TypeScript loader — tries standard require first, then the Node-RED container path.
let _ts = undefined;
function loadTypeScript() {
  if (_ts !== undefined) return _ts;
  try { _ts = require("typescript"); return _ts; } catch {}
  try { _ts = require("/config/node_modules/typescript"); return _ts; } catch {}
  _ts = null;
  return _ts;
}

// textAsTemplateLiteral escapes text to form the body of template literal
function textAsTemplateLiteral(txt) {
  let out = "";
  for (const c of txt) {
    out += textEscapes[c] || c;
  }
  return out;
}

// saveFile saves data to dirPath/fileName using stream
async function saveFile(dirPath, fileName, data) {
  const stream = fs.createWriteStream(fspath.join(dirPath, fileName));
  await new Promise((res) => stream.write(data, res));
  await new Promise((res) => stream.end(res));
}

// ConvertNode is added and executed inside the js file to extract Node JSON with functions as strings
function ConvertNode(jsstore) {
  const funcIndent = "  "; // Re-define for vm
  const outdent = (code) => {
    const lines = code.split(/\r?\n/);
    let out = [];
    for (let line of lines) {
      if (line.startsWith(funcIndent)) {
        out.push(line.substring(funcIndent.length));
      } else {
        if (line.length > 0) {
          out = lines; // skip outdenting, format has been changed
          break;
        }
      }
    }
    return out.join("\n");
  };
  const getBody = (s) => s.substring(s.indexOf("{") + 1, s.lastIndexOf("}"));

  for (let fn of ["initialize", "func", "finalize"]) {
    if (typeof Node[fn] === "function") {
      Node[fn] = outdent(getBody(Node[fn].toString()));
    }
  }

  // Remove first and last char (newline) from template literals
  for (let txt of ["info", "template"]) {
    if (Node[txt] && Node[txt] !== "") {
      Node[txt] = Node[txt].slice(1, -1);
    }
  }

  jsstore.Node = Node;
}

// extractTypeScriptFunc extracts the TypeScript func body from a .flows.js file,
// transpiles it to JavaScript for VM evaluation, and returns both the original
// TypeScript source and the modified file content with transpiled JS substituted.
//
// The write path stores TypeScript source verbatim in the func block. The VM cannot
// parse TypeScript syntax, so we transpile only for the purpose of VM evaluation,
// then restore the original source after the node object is reconstructed.
function extractTypeScriptFunc(data) {
  const ts = loadTypeScript();
  if (!ts) {
    throw new Error(
      logPrefix +
        "TypeScript compiler not available. Cannot read typescript node. " +
        "Install the 'typescript' package or ensure it is present at /config/node_modules/typescript."
    );
  }

  const headerMatch = data.match(/Node\.func = async function \([^)]*\) \{/);
  if (!headerMatch) return null;

  // bodyStart is the index of the first character after the opening "{\n"
  const bodyStart = headerMatch.index + headerMatch[0].length + 1;

  // The func block closing "}" is the last "\n}" before "module.exports = Node;"
  const moduleExportsIdx = data.lastIndexOf("\nmodule.exports");
  const closingIdx = data.lastIndexOf("\n}", moduleExportsIdx);

  if (closingIdx <= bodyStart) return null;

  const indentedBody = data.substring(bodyStart, closingIdx);

  // Un-indent to recover the original TypeScript source (indent() adds 2 spaces to every line)
  const originalTS = indentedBody
    .split("\n")
    .map((line) =>
      line.startsWith(funcIndent) ? line.substring(funcIndent.length) : line
    )
    .join("\n");

  // Transpile TypeScript to JavaScript so the VM can evaluate the file
  const transpiled = ts.transpileModule(originalTS, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
    },
  });

  // Re-indent the transpiled JS to match the expected file structure
  const indentedTranspiled = transpiled.outputText
    .trimEnd()
    .split("\n")
    .map((line) => (line.length > 0 ? funcIndent + line : line))
    .join("\n");

  // Substitute the transpiled JS into the file content
  const transpiledData =
    data.substring(0, bodyStart) +
    indentedTranspiled +
    data.substring(closingIdx);

  return { originalTS, transpiledData };
}

// js2json creates Node-RED node object out of js file contents
function js2json(data) {
  if (Buffer.isBuffer(data)) data = data.toString("utf8");
  const context = { jsstore: {}, module: {} };
  vm.createContext(context);
  const getNode = "\n" + ConvertNode.toString() + "ConvertNode(jsstore);";

  let originalTS = null;
  let dataForVM = data;

  // TypeScript nodes store TS source in func — the VM cannot parse TS syntax directly.
  // Extract and transpile the func body before VM evaluation, then restore the original.
  if (data.includes('"type": "typescript"')) {
    const extracted = extractTypeScriptFunc(data);
    if (extracted) {
      originalTS = extracted.originalTS;
      dataForVM = extracted.transpiledData;
    }
  }

  vm.runInContext(dataForVM + getNode, context);
  const node = context.jsstore.Node;

  if (originalTS !== null) {
    node.func = originalTS;
  }

  return node;
}

// json2js returns js file contents and the filename (where filename is the type + node id + .flows.js extension) out of Node-RED node object
function json2js(json) {
  const separator = "\n\n";

  // Add libraries to the list of default function parameters
  const fnParams = funcParameters.slice();
  if (json.hasOwnProperty("libs")) {
    for (let lib of json.libs) {
      if (lib.hasOwnProperty("var")) {
        fnParams.push(lib.var);
      }
    }
  }

  const extracted = [];

  // Extract info and template as template literals
  for (let txt of ["info", "template"]) {
    if (json.hasOwnProperty(txt) && json[txt] !== "") {
      let prefix = textPrefix(txt);
      let code = prefix + textAsTemplateLiteral(json[txt]) + textSuffix;
      extracted.push(code);
      json[txt] = ""; // preserves position in object to keep same hash
    }
  }

  // Extract function scripts
  for (let fn of ["initialize", "func", "finalize"]) {
    if (json.hasOwnProperty(fn) && json[fn] !== "") {
      let code = indent(json[fn]);
      let prefix = funcPrefix(fn, fnParams);
      code = prefix + "\n" + code + "\n" + funcSuffix;
      extracted.push(code);
      json[fn] = ""; // preserves position in object to keep same hash
    }
  }

  // Sanitize json type for file name
  const safeType = json.type.replace(/[^a-z0-9]/gi, "_").toLowerCase();

  // Return js code and file name
  return [
    nodePrefix +
      JSON.stringify(json, null, 2) +
      (extracted.length > 0 ? separator : "") +
      extracted.join(separator) +
      separator +
      nodeSuffix,
    safeType + "." + json.id + storageExtension,
  ];
}

// indent indents function code with 2 spaces
function indent(code) {
  return code
    .split(/\r?\n/)
    .map((line) => funcIndent + line)
    .join("\n");
}

// normalizeFlowsOrder sorts flows in-place to canonical order:
//   1. type:"tab" nodes — preserved in received sequence (user's tab bar order)
//   2. type:"subflow" definition nodes (!node.z) — sorted by name then id
//   3. everything else — sorted by id
// Called by saveFlows so H_save == H_get on next startup.
function normalizeFlowsOrder(flows) {
  const tabs   = flows.filter(n => n.type === 'tab');
  const sfDefs = flows.filter(n => n.type === 'subflow' && !n.z);
  const rest   = flows.filter(n => n.type !== 'tab' && !(n.type === 'subflow' && !n.z));

  sfDefs.sort((a, b) => {
    const c = (a.name || '').localeCompare(b.name || '');
    return c !== 0 ? c : a.id.localeCompare(b.id);
  });
  rest.sort((a, b) => a.id.localeCompare(b.id));

  flows.splice(0, flows.length, ...tabs, ...sfDefs, ...rest);
}

// subDirs lists the three subdirectories used in the structured layout.
const subDirs = ["tabs", "subflows", "config-nodes"];

// hasSubDirLayout returns true if dirPath contains the structured subdirectory layout.
function hasSubDirLayout(dirPath) {
  return fs.existsSync(fspath.join(dirPath, "tabs")) &&
         fs.existsSync(fspath.join(dirPath, "subflows")) &&
         fs.existsSync(fspath.join(dirPath, "config-nodes"));
}

// collectFlowsJsFiles recursively collects all .flows.js files under dirPath,
// returning objects { relPath, absPath } where relPath is relative to dirPath.
function collectFlowsJsFiles(dirPath) {
  const results = [];
  function walk(absDir, relDir) {
    for (const entry of fs.readdirSync(absDir)) {
      const absEntry = fspath.join(absDir, entry);
      const relEntry = relDir ? relDir + "/" + entry : entry;
      const stat = fs.statSync(absEntry);
      if (stat.isDirectory()) {
        walk(absEntry, relEntry);
      } else if (entry.endsWith(storageExtension)) {
        results.push({ relPath: relEntry, absPath: absEntry });
      }
    }
  }
  walk(dirPath, "");
  return results;
}

// nodeSubDir computes the relative subdirectory path and filename for a node
// given sets of tab IDs and subflow definition IDs.
function nodeSubDir(node, tabIds, sfIds) {
  const safeType = node.type.replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const id = node.id;

  if (node.type === "tab") {
    return { subdir: "tabs/tab." + id, fileName: "_tab." + id + storageExtension };
  }
  if (node.type === "subflow" && !node.z) {
    return { subdir: "subflows/subflow." + id, fileName: "_subflow." + id + storageExtension };
  }
  if (node.z && tabIds.has(node.z)) {
    return { subdir: "tabs/tab." + node.z, fileName: safeType + "." + id + storageExtension };
  }
  if (node.z && sfIds.has(node.z)) {
    return { subdir: "subflows/subflow." + node.z, fileName: safeType + "." + id + storageExtension };
  }
  return { subdir: "config-nodes", fileName: safeType + "." + id + storageExtension };
}

// readJSONArrayFromJSFiles reads dirPath and returns JSON array from .flows.js files
// in canonical order: tabs (per _tab-order.txt), subflow defs (name+id), rest (id).
// Supports both the structured subdirectory layout (tabs/, subflows/, config-nodes/)
// and the legacy flat layout for backward compatibility.
function readJSONArrayFromJSFiles(dirPath, emptyResponse) {
  let out = [];

  // Read tabs/_tab-order.txt for tab sequence.
  // On any error (missing file, bad content) fall back to sorting tabs by id.
  let tabOrder = [];
  try {
    const raw = fs.readFileSync(fspath.join(dirPath, 'tabs', tabOrderFileName), 'utf8');
    tabOrder = raw.split('\n').map(l => l.trim()).filter(Boolean);
  } catch (e) {
    // fallback: tabOrder stays empty
  }

  try {
    let files; // array of { relPath, absPath }

    if (hasSubDirLayout(dirPath)) {
      // Structured layout: walk the three subdirectories
      files = collectFlowsJsFiles(dirPath);
    } else {
      // Legacy flat layout: all .flows.js files directly in dirPath
      files = fs.readdirSync(dirPath)
        .filter((f) => f.endsWith(storageExtension))
        .map((f) => ({ relPath: f, absPath: fspath.join(dirPath, f) }));
    }

    for (const { absPath } of files) {
      const data = fs.readFileSync(absPath);
      out.push(js2json(data));
    }

    // Sort to canonical order
    const tabOrderMap = new Map(tabOrder.map((name, i) => [name, i]));
    const tabs   = out.filter(n => n.type === 'tab');
    const sfDefs = out.filter(n => n.type === 'subflow' && !n.z);
    const rest   = out.filter(n => n.type !== 'tab' && !(n.type === 'subflow' && !n.z));

    tabs.sort((a, b) => {
      const ai = tabOrderMap.get('tab.' + a.id) ?? Infinity;
      const bi = tabOrderMap.get('tab.' + b.id) ?? Infinity;
      return ai !== bi ? ai - bi : a.id.localeCompare(b.id);
    });
    sfDefs.sort((a, b) => {
      const c = (a.name || '').localeCompare(b.name || '');
      return c !== 0 ? c : a.id.localeCompare(b.id);
    });
    rest.sort((a, b) => a.id.localeCompare(b.id));

    out = [...tabs, ...sfDefs, ...rest];

    if (out.length === 0) {
      return emptyResponse;
    }
  } catch (e) {
    console.warn(logPrefix + "Invalid file", e.message);
    return emptyResponse;
  }
  return out;
}

// writeJSONArrayToJSFiles creates .flows.js files in the structured subdirectory layout.
async function writeJSONArrayToJSFiles(dirPath, content) {
  const fileNames = []; // relative paths, e.g. "tabs/tab.ID/_tab.ID.flows.js"
  const contentClone = JSON.parse(JSON.stringify(content));

  // First pass: build sets of tab IDs and subflow definition IDs for routing
  const tabIds = new Set();
  const sfIds = new Set();
  for (const node of contentClone) {
    if (node.type === "tab") tabIds.add(node.id);
    if (node.type === "subflow" && !node.z) sfIds.add(node.id);
  }

  try {
    for (const node of contentClone) {
      const { subdir, fileName } = nodeSubDir(node, tabIds, sfIds);
      const absSubdir = fspath.join(dirPath, subdir);
      fs.mkdirSync(absSubdir, { recursive: true });

      // json2js generates file content and a flat filename; we use our own fileName
      const [data] = json2js(node);
      await saveFile(absSubdir, fileName, data);
      fileNames.push(subdir + "/" + fileName);
    }
  } catch (e) {
    throw new Error(`${logPrefix}Failed saving to ${dirPath} (${e.message})`);
  }

  // Remove orphaned .flows.js files across all subdirectories
  try {
    const existing = collectFlowsJsFiles(dirPath).map(({ relPath }) => relPath);
    for (const relPath of existing) {
      if (!fileNames.includes(relPath)) {
        fs.unlinkSync(fspath.join(dirPath, relPath));
      }
    }
    // Remove empty leaf directories (tabs/tab.ID/ left behind after node deletion)
    for (const topDir of subDirs) {
      const absTop = fspath.join(dirPath, topDir);
      if (!fs.existsSync(absTop)) continue;
      if (topDir === "config-nodes") continue; // flat, no subdirs to prune
      for (const child of fs.readdirSync(absTop)) {
        const absChild = fspath.join(absTop, child);
        if (fs.statSync(absChild).isDirectory() && fs.readdirSync(absChild).length === 0) {
          fs.rmdirSync(absChild);
        }
      }
    }
  } catch (e) {
    throw new Error(`${logPrefix}Failed cleaning up old files (${e.message})`);
  }

  // Save _tab-order.txt in tabs/ with one directory name per line
  try {
    const tabDirNames = contentClone
      .filter(n => n.type === 'tab')
      .map(n => 'tab.' + n.id);
    await saveFile(
      fspath.join(dirPath, 'tabs'),
      tabOrderFileName,
      tabDirNames.join('\n') + '\n'
    );
  } catch (e) {
    throw new Error(`${logPrefix}Error saving ${tabOrderFileName} (${e.message})`);
  }
}

module.exports = {
  readJSONArrayFromJSFiles,
  writeJSONArrayToJSFiles,
  normalizeFlowsOrder,

  // test exports
  _js2json: js2json,
  _json2js: json2js,
  _storageExtension: storageExtension,
};
