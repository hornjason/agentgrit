import { resolve } from "path";
import { afterAll } from "bun:test";
import { runScaffoldConformity, runSpecDiscovery, runSpecDrift, runDocHygiene, runFallowCheck, runAgentFileValidation, runPackageValidation, runTsconfigValidation, writeFindingsReport } from "rungate/lib/conformity";

const ROOT = resolve(import.meta.dir, "..");
const findings: any[] = [];

runScaffoldConformity(ROOT, findings);
runSpecDiscovery(ROOT, findings);
runSpecDrift(ROOT, findings);
runDocHygiene(ROOT, findings);
runFallowCheck(ROOT, findings);
runAgentFileValidation(ROOT, findings);
runPackageValidation(ROOT, findings);
runTsconfigValidation(ROOT, findings);

afterAll(() => writeFindingsReport(ROOT, findings));
