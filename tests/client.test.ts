import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import {
  apply,
  fieldKind,
  FIELDS,
  inject,
  larkOpenPlatformUrl,
  schemaDictionary,
  selectOptions,
  type SchemaNode,
} from "../src/client.js";
import { Config } from "../src/lark-config.js";

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
      key: "dsh-lark-bridge",
      locale: "dsh-lark.settings",
    },
  ]);
});

test("field controls are derived from the real config schema, not a hand table", () => {
  // The three hardcoded Sets this replaced had to track `Config` by hand; a new
  // field silently rendered as a text box and saved the wrong type.
  const dict = (Config as unknown as { dict: Record<string, SchemaNode> }).dict;

  assert.equal(fieldKind(dict.enabled), "boolean");
  assert.equal(fieldKind(dict.enableApprovals), "boolean");
  assert.equal(fieldKind(dict.maxConcurrentTopics), "number");
  assert.equal(fieldKind(dict.streamElementMaxChars), "number");
  assert.equal(fieldKind(dict.allowedSenderIds), "list", "SenderIdList is a transform");
  assert.equal(fieldKind(dict.blockedSenderIds), "list");
  assert.equal(fieldKind(dict.workspacePath), "text");
  assert.equal(fieldKind(dict.appId), "text");
  assert.equal(fieldKind(dict.domain), "select");
  assert.equal(fieldKind(dict.replyMode), "select");
  assert.equal(fieldKind(undefined), "text", "an unknown field degrades to text");

  assert.deepEqual(selectOptions(dict.domain), ["feishu", "lark"]);
  assert.deepEqual(selectOptions(dict.replyMode), ["post", "card"]);
  assert.deepEqual(selectOptions(dict.enabled), []);
});

test("field controls resolve the serialized Schemastery reference graph served by settings", () => {
  const serialized = (Config as unknown as { toJSON(): unknown }).toJSON();
  const dict = schemaDictionary(serialized);

  assert.equal(fieldKind(dict.allowSlashCommands), "boolean");
  assert.equal(fieldKind(dict.enableCot), "boolean");
  assert.equal(fieldKind(dict.streamElementMaxChars), "number");
  assert.equal(fieldKind(dict.allowedSenderIds), "list");
  assert.deepEqual(selectOptions(dict.domain), ["feishu", "lark"]);
  assert.deepEqual(selectOptions(dict.replyMode), ["post", "card"]);
});

test("every schema field is reachable from the settings form", () => {
  const declared = Object.keys(
    (Config as unknown as { dict: Record<string, unknown> }).dict,
  );
  const rendered = new Set(FIELDS.map((field) => field.name));
  const missing = declared.filter((name) => !rendered.has(name as never));
  assert.deepEqual(missing, [], "a schema field with no form entry is unreachable");
});

test("bot credentials lead the form and link to the matching Open Platform app", () => {
  assert.equal(FIELDS[0]?.name, "appId");
  assert.equal(FIELDS.some((field) => field.name === "agentPreset" as never), false);
  assert.equal(
    larkOpenPlatformUrl(" cli_test ", "feishu"),
    "https://open.feishu.cn/app/cli_test",
  );
  assert.equal(
    larkOpenPlatformUrl("cli/global", "lark"),
    "https://open.larksuite.com/app/cli%2Fglobal",
  );
  assert.equal(larkOpenPlatformUrl("  ", "feishu"), undefined);
});
