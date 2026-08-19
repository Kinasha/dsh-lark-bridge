import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_INTERRUPT_EMOJI,
  decodeBotMenuEvent,
  decodeReactionEvent,
  menuCommand,
  reactionCommand,
} from "../../src/lark/menu.js";

test("decodes a bot menu event, converting its seconds stamp", () => {
  const decoded = decodeBotMenuEvent({
    schema: "2.0",
    header: { event_type: "application.bot.menu_v6" },
    event: {
      operator: {
        operator_name: "张三",
        operator_id: { open_id: "ou_1", user_id: "e33", union_id: "on_1" },
      },
      event_key: "dsh_stop",
      timestamp: 1_669_364_458,
    },
  });
  assert.deepEqual(decoded, {
    eventKey: "dsh_stop",
    operatorOpenId: "ou_1",
    timestamp: 1_669_364_458_000,
  });
});

test("the menu decoder is total", () => {
  for (const bad of [
    null,
    undefined,
    42,
    "x",
    {},
    { event: {} },
    { event: { event_key: "dsh_stop" } },
    { event: { operator: { operator_id: { open_id: "ou_1" } } } },
    { event: { event_key: "  ", operator: { operator_id: { open_id: "ou_1" } } } },
  ]) {
    assert.equal(decodeBotMenuEvent(bad), undefined, JSON.stringify(bad) ?? "undefined");
  }
});

test("maps configured menu keys and ignores unknown ones", () => {
  const event = { eventKey: "dsh_stop", operatorOpenId: "ou_1" };
  assert.deepEqual(menuCommand(event), {
    kind: "stop",
    operatorOpenId: "ou_1",
    source: "menu",
  });
  assert.deepEqual(menuCommand({ ...event, eventKey: "dsh_new_topic" })?.kind, "new_topic");
  assert.equal(menuCommand({ ...event, eventKey: "unconfigured" }), undefined);
  assert.deepEqual(
    menuCommand({ ...event, eventKey: "custom" }, { custom: "help" })?.kind,
    "help",
  );
});

test("decodes a reaction event", () => {
  const decoded = decodeReactionEvent({
    schema: "2.0",
    event: {
      message_id: "om_1",
      reaction_type: { emoji_type: "X" },
      operator_type: "user",
      user_id: { open_id: "ou_1", user_id: "e33" },
      action_time: "1699999999999",
    },
  });
  assert.deepEqual(decoded, {
    messageId: "om_1",
    emojiType: "X",
    operatorOpenId: "ou_1",
    operatorType: "user",
  });
});

test("the reaction decoder is total", () => {
  for (const bad of [
    null,
    undefined,
    "x",
    {},
    { event: { message_id: "om_1" } },
    { event: { message_id: "om_1", reaction_type: {} } },
    { event: { reaction_type: { emoji_type: "X" }, user_id: { open_id: "ou_1" } } },
  ]) {
    assert.equal(decodeReactionEvent(bad), undefined, JSON.stringify(bad) ?? "undefined");
  }
});

test("interrupts on the configured emoji only, and never for the bot's own", () => {
  const base = {
    messageId: "om_1",
    emojiType: DEFAULT_INTERRUPT_EMOJI,
    operatorOpenId: "ou_1",
    operatorType: "user" as const,
  };
  assert.deepEqual(reactionCommand(base), {
    kind: "stop",
    operatorOpenId: "ou_1",
    messageId: "om_1",
    source: "reaction",
  });
  assert.equal(reactionCommand({ ...base, emojiType: "THUMBSUP" }), undefined);
  assert.equal(
    reactionCommand({ ...base, operatorType: "app" }),
    undefined,
    "the bot's own reaction must not command the bot",
  );
  assert.deepEqual(
    reactionCommand({ ...base, emojiType: "DONE" }, { interruptEmoji: "DONE" })?.kind,
    "stop",
  );
});
