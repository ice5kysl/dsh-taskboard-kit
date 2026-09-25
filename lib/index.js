// src/host/index.ts
var name = "taskboard-kit";
var inject = ["tools", "sessions"];
function apply(ctx) {
  ctx.logger("taskboard-kit").info("taskboard-kit loaded (skeleton)");
}
export {
  apply,
  inject,
  name
};
