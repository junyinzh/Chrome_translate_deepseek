const $ = selector => document.querySelector(selector);

function message(text, error = false) {
  $("#message").textContent = text;
  $("#message").className = `message${error ? " error" : ""}`;
  $("#message").hidden = !text;
}

function readForm() {
  return {apiKey: $("#api-key").value.trim(), model: $("#model").value, targetLanguage: $("#language").value,
    scope: $("#scope").value, concurrency: Number($("#concurrency").value), dynamic: $("#dynamic").checked,
    glossary: $("#glossary").value.trim()};
}

async function request(data) {
  const result = await chrome.runtime.sendMessage(data);
  if (!result?.ok) throw new Error(result?.error || "插件后台没有响应，请重新加载插件。");
  return result;
}

async function withBusy(action) {
  const buttons = [...document.querySelectorAll("form button")];
  buttons.forEach(button => { button.disabled = true; });
  try { await action(); }
  catch (error) { message(error.message, true); }
  finally { buttons.forEach(button => { button.disabled = false; }); }
}

$("#settings-form").addEventListener("submit", event => {
  event.preventDefault();
  withBusy(async () => {
    await request({type: "PL_SAVE_SETTINGS", settings: readForm()});
    $("#key-hint").textContent = $("#api-key").value.trim() ? "API Key 已配置。" : "填写 API Key 后即可翻译。";
    message("设置已保存。回到网页，点击 PageLingo 开始翻译。");
  });
});

$("#test").addEventListener("click", () => withBusy(async () => {
  message("正在连接 DeepSeek，并翻译一条测试句子…");
  const result = await request({type: "PL_TEST_CONNECTION", settings: readForm()});
  const tokens = result.usage?.total_tokens;
  message(`连接成功 · ${result.model}\n测试译文：${result.text}${tokens ? `\n本次使用 ${tokens} tokens` : ""}`);
}));

$("#reveal").addEventListener("click", () => {
  const reveal = $("#api-key").type === "password";
  $("#api-key").type = reveal ? "text" : "password";
  $("#reveal").textContent = reveal ? "隐藏" : "显示";
});

$("#clear-cache").addEventListener("click", () => withBusy(async () => {
  await request({type: "PL_CLEAR_CACHE"});
  message("翻译缓存已清除。");
}));

try {
  const {settings} = await request({type: "PL_GET_SETTINGS"});
  $("#api-key").value = settings.apiKey;
  if (![...$("#model").options].some(option => option.value === settings.model)) {
    $("#model").add(new Option(settings.model, settings.model));
  }
  $("#model").value = settings.model;
  $("#language").value = settings.targetLanguage;
  $("#scope").value = settings.scope;
  $("#concurrency").value = String(settings.concurrency);
  $("#dynamic").checked = settings.dynamic;
  $("#glossary").value = settings.glossary;
  $("#key-hint").textContent = settings.apiKey ? "API Key 已配置，可以直接使用。" : "填写 API Key 后即可翻译。";
} catch (error) { message(error.message, true); }
