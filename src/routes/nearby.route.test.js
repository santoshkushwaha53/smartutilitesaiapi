const assert = require("node:assert");
const test = require("node:test");

const router = require("./nearby.route");

test("nearby route should export an Express router", () => {
  assert.ok(router, "Router should be exported");
  assert.strictEqual(typeof router, "function", "Export should be a function");
});

test("nearby route should register GET /nearby-free", () => {
  const found = (router.stack || []).some((layer) => {
    return layer.route?.path === "/nearby-free" && layer.route?.methods?.get;
  });

  assert.ok(found, "Router should contain GET /nearby-free");
});
