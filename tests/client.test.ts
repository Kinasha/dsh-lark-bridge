import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { apply, inject } from "../src/client.js";

test("the package manifest is exported for DSH client discovery", () => {
  const require = createRequire(import.meta.url);
  assert.match(
    require.resolve("@open-aiden/dsh-lark-bridge/package.json"),
    /package\.json$/,
  );
});

test("the browser half registers a Lark card in DSH unified plugin settings", () => {
  const registrations: Array<Record<string, unknown>> = [];
  const dictionaries: string[] = [];
  const context = {
    effect: (effect: () => unknown) => effect(),
    locale: {
      register: (namespace: string) => {
        dictionaries.push(namespace);
        return () => undefined;
      },
      bind: () => (key: string) => key,
      subscribe: () => () => undefined,
      getSnapshot: () => ({ revision: 0 }),
    },
    slots: {
      inject: (name: string, register: () => unknown) => {
        assert.equal(name, "settings.plugin.item");
        register();
      },
      register: (options: Record<string, unknown>) => {
        registrations.push(options);
        return () => undefined;
      },
    },
  };

  apply(context as never);

  assert.deepEqual(inject, ["slots", "locale"]);
  assert.deepEqual(dictionaries, ["dsh-lark.settings"]);
  assert.deepEqual(registrations, [
    {
      name: "settings.plugin.item",
      id: "dsh-lark-bridge",
      order: 30,
      locale: "dsh-lark.settings",
    },
  ]);
});
