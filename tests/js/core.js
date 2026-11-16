// The modules under test, loaded from the web application.
// (In the built site this file sits in /tests/, next to /assets/.)
import * as sha256 from '../assets/js/core/sha256.js';
import * as ids from '../assets/js/core/ids.js';
import * as jsonfmt from '../assets/js/core/jsonfmt.js';
import * as schema from '../assets/js/core/schema.js';
import * as checks from '../assets/js/core/checks.js';
import * as cite from '../assets/js/core/cite.js';
import * as convert from '../assets/js/core/convert.js';
import * as format from '../assets/js/core/format.js';
import * as backend from '../assets/js/admin/backend.js';
import * as workspace from '../assets/js/admin/workspace.js';
import * as diff from '../assets/js/admin/diff.js';
import * as paste from '../assets/js/admin/paste.js';

export const core = { sha256, ids, jsonfmt, schema, checks, cite, convert, format, backend, workspace, diff, paste };
