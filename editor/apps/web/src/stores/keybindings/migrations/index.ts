import { v2ToV3 } from "./v2-to-v3";
import { v3ToV4 } from "./v3-to-v4";
import { v4ToV5 } from "./v4-to-v5";
import { v5ToV6 } from "./v5-to-v6";
import { v6ToV7 } from "./v6-to-v7";
import { v7ToV8 } from "./v7-to-v8";
import { v8ToV9 } from "./v8-to-v9";
import { v9ToV10 } from "./v9-to-v10";

type MigrationFn = ({ state }: { state: unknown }) => unknown;

const migrations: Record<number, MigrationFn> = {
	2: v2ToV3,
	3: v3ToV4,
	4: v4ToV5,
	5: v5ToV6,
	6: v6ToV7,
	7: v7ToV8,
	8: v8ToV9,
	9: v9ToV10,
};

export const CURRENT_VERSION = 10;

export function runMigrations({
	state,
	fromVersion,
}: {
	state: unknown;
	fromVersion: number;
}): unknown {
	let current = state;
	for (let version = fromVersion; version < CURRENT_VERSION; version++) {
		const migrate = migrations[version];
		if (migrate) current = migrate({ state: current });
	}
	return current;
}
