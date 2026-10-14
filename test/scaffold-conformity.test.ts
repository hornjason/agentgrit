import { resolve } from "path";
import { afterAll } from "bun:test";
import { runScaffoldConformity, runSpecDiscovery, runSpecDrift, runDocHygiene, runFallowCheck, runAgentFileValidation, runDirectoryValidation, runPackageValidation, runTsconfigValidation, writeFindingsReport } from "rungate/lib/conformity";

const ROOT = resolve(import.meta.dir, "..");

runScaffoldConformity(ROOT);
runSpecDiscovery(ROOT);
runSpecDrift(ROOT);
runDocHygiene(ROOT);
runFallowCheck(ROOT);
runAgentFileValidation(ROOT);
runDirectoryValidation(ROOT);
runPackageValidation(ROOT);
runTsconfigValidation(ROOT);

afterAll(() => writeFindingsReport(ROOT));
