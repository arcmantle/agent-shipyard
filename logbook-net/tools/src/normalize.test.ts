import { expect, test } from "bun:test";
import { createNormalizer } from "./normalize.ts";

const REF = "ISS_5B3MQT4H728DKSDBJC2H3ZQ96X";
const OTHER = "ISS_2MKH5NFQJA8ECV16C1DAGMMP6H";

test("approved normalization makes two recordings equal", () => {
	const first = { b: `line\r\n${REF} /tmp/a1/ws`, a: { at: "2026-01-01T10:00:00.123Z", id: "AAAAAAAA-0000-4000-8000-000000000001", t: "tenant-1" }, list: [REF, OTHER] };
	const second = { a: { t: "tenant-2", id: "bbbbbbbb-0000-4000-8000-000000000009", at: "2027-05-05T01:02:03+02:00" }, b: `line\n${REF.replace("5B3MQT4H", "5B3MQT4H")} /var/b2/ws`, list: [REF, OTHER] };
	const one = createNormalizer({ "/tmp/a1": "<root>", "tenant-1": "<tenant>" })(first);
	const two = createNormalizer({ "/var/b2": "<root>", "tenant-2": "<tenant>" })(second);
	expect(JSON.stringify(one)).toBe(JSON.stringify(two));
});

test("placeholders follow first appearance", () => {
	const out = createNormalizer()([OTHER, REF, OTHER]);
	expect(out).toEqual(["<ref#1>", "<ref#2>", "<ref#1>"]);
});

test("differences that are not approved stay distinct", () => {
	const normalize = (value: unknown) => JSON.stringify(createNormalizer()(value));
	const hash = "12efec0984d8a5247c429fa7e0b9413742f7dd5bfa906fc374dd0103b29b98a1";
	expect(normalize({ h: hash })).not.toBe(normalize({ h: hash.replace("12", "13") }));
	expect(normalize([1, 2])).not.toBe(normalize([2, 1]));
	expect(normalize({ n: 1 })).not.toBe(normalize({ n: "1" }));
	expect(normalize({ a: null })).not.toBe(normalize({}));
	expect(normalize({ a: 1, b: 2 })).toBe(normalize({ b: 2, a: 1 }));
	expect(normalize([REF, OTHER])).not.toBe(normalize([REF, REF]));
});
