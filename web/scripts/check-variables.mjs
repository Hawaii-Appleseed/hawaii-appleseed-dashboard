// `npm run check`: validate src/config/variables.json against its references
// and the built data. Exits 1 on errors; warnings are printed but pass.
import { runCheck, formatReport } from './variables-config.mjs';

const result = runCheck();
const report = formatReport(result);
if (result.errors.length) {
  console.error(report);
  process.exit(1);
}
console.log(report ? `${report}\nNo errors.` : 'src/config/variables.json: no problems.');
