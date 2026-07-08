'use strict';

const os = require('os');
const path = require('path');

// Shared kit data dir. WEBMCP_HOME is the canonical variable used across the
// WebMCP kit; WEBMCP_DATA_DIR is kept as a back-compat alias. The vault lives
// under this directory as vault/credentials.enc.json.
function getDataDir() {
  return process.env.WEBMCP_HOME
    || process.env.WEBMCP_DATA_DIR
    || path.join(os.homedir(), '.webmcp');
}

module.exports = { getDataDir };
