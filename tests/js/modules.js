// The modules under test on the browser test page of the published site
// (in the built site this file sits in /tests/, next to /assets/).  The tests
// of the data entry tool (tests/admin) run with Node only.
import * as sha256 from '../assets/js/core/sha256.js';
import * as ids from '../assets/js/core/ids.js';
import * as jsonfmt from '../assets/js/core/jsonfmt.js';
import * as schema from '../assets/js/core/schema.js';
import * as database from '../assets/js/core/database.js';
import * as cite from '../assets/js/core/cite.js';
import * as convert from '../assets/js/core/convert.js';
import * as format from '../assets/js/core/format.js';
import * as nuclides from '../assets/js/core/nuclides.js';
import * as model from '../assets/js/explorer/model.js';
import * as selection from '../assets/js/explorer/selection.js';
import * as versioning from '../assets/js/explorer/versioning.js';
import * as route from '../assets/js/explorer/route.js';
import * as citation from '../assets/js/explorer/citation.js';

export const modules = { sha256, ids, jsonfmt, schema, database, cite, convert, format, nuclides, model, selection, versioning, route, citation };
