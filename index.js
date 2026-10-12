/*
项目名称：dnshe-renew-worker
访问地址：部署后为你的workers域名
功能：DNSHE子域名自动续期网页面板
API文档参考：https://my.dnshe.com/knowledgebase/13/DNSHE-Free-Domain-API-User-Guide-V2.0.html

【DNSHE官方规则】
免费域名注册有效期1年；仅到期前180天以内，API才允许提交免费续期；
续期成功：到期时间直接增加365天；
never_expires=1：永久域名，无需续期，永久有效。

【运行逻辑说明】
1. 调用DNSHE v2 API，拉取账号全部域名列表
2. 遍历域名：
   - never_expires =1 → 永久域名，跳过，日志输出：到期时间:永久有效
   - never_expires =0 → 普通免费域名，读取expires_at到期时间，计算剩余天数
3. 续期触发规则：剩余天数 ≤180天，发起续期请求
   - 剩余>180天：官方未开放续期，跳过
   - 续期成功：到期时间+365天，下一轮巡检时剩余天数远大于180，不会再次触发
   - 续期失败：下一次Cron执行会继续重试（兜底）
4. 页面日志输出：每个域名到期时间、剩余天数、续期结果；结束输出汇总统计

【定时Cron策略】
Cron设置：每90天自动运行一次
优点：资源消耗低；正常场景仅执行一次续期；续期失败可提供1次重试冗余，作为兜底保障
缺点：窗口期内最多2次尝试；如果两轮执行全部失败，域名会过期，需要人工关注日志

【当前已知永久域名（仅记录存档，非硬编码黑名单）】
zoeay.us.ci (ID:229156)，接口返回 never_expires=1，自动跳过
> 新增其他永久域名无需修改代码，自动识别never_expires字段

【环境变量】
API_KEY
API_SECRET

【更新日志】
2026-10-12
1. 每条域名日志增加到期时间输出；永久域名标记到期时间:永久有效
2. 增加统计项：本次总计续费成功X个域名
3. 日志面板改为白底黑字
4. 修正：续期成功，到期时间直接+365天
*/
const API_HOST = "https://my.dnshe.com";
const API_VERSION = "v2";
const RENEW_BEFORE_DAYS = 180;
const DAY_SECONDS = 24 * 60 * 60;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      return await handleRun(env);
    }
    return new Response(pageHtml(), {
      headers: { "content-type": "text/html;charset=utf-8" }
    });
  }
};

async function handleRun(env) {
  const stream = new ReadableStream({
    async start(controller) {
      const send = (msg) => {
        controller.enqueue(`data: ${JSON.stringify(msg)}\n\n`);
      };
      let renewSuccessCount = 0;
      try {
        if (!env.API_KEY || !env.API_SECRET) {
          send("❌ 错误：请配置环境变量 API_KEY 和 API_SECRET");
          controller.close();
          return;
        }
        const listResp = await fetch(`${API_HOST}/api/${API_VERSION}/domain/list`, {
          method: "GET",
          headers: {
            "X-API-Key": env.API_KEY,
            "X-API-Secret": env.API_SECRET,
            "User-Agent": "CloudflareWorker-DNSHE-Renew"
          }
        });
        const listJson = await listResp.json();
        if (!listJson.success) {
          send(`❌ 获取域名列表失败：${listJson.message}`);
          controller.close();
          return;
        }
        const domains = listJson.data;
        send(`找到 ${domains.length} 个域名，仅剩余 ≤${RENEW_BEFORE_DAYS} 天才执行续期`);
        for (const item of domains) {
          const id = item.id;
          const domain = item.domain;
          send(`处理: ${domain} (ID:${id})`);
          if (item.never_expires === 1) {
            send(`✅ ${domain} 永久域名，到期时间:永久有效，跳过`);
            await sleep(300);
            continue;
          }
          const expireStr = item.expires_at;
          send(`到期时间:${expireStr}`);
          const expireTime = new Date(expireStr).getTime();
          const now = Date.now();
          const remainMs = expireTime - now;
          const remainDays = Math.floor(remainMs / (1000 * DAY_SECONDS));
          send(`剩余天数:${remainDays}`);
          if (remainDays > RENEW_BEFORE_DAYS) {
            send(`剩余天数大于${RENEW_BEFORE_DAYS}天，暂不续期`);
            await sleep(300);
            continue;
          }
          // 发起续期
          const renewResp = await fetch(`${API_HOST}/api/${API_VERSION}/domain/renew`, {
            method: "POST",
            headers: {
              "X-API-Key": env.API_KEY,
              "X-API-Secret": env.API_SECRET,
              "Content-Type": "application/json",
              "User-Agent": "CloudflareWorker-DNSHE-Renew"
            },
            body: JSON.stringify({ id: item.id })
          });
          const renewResult = await renewResp.json();
          if (renewResult.success) {
            renewSuccessCount +=1;
            send(`🎉 ${domain} 续期成功！接口返回信息：${renewResult.message}`);
          } else {
            send(`❌ ${domain} 续期失败，原因：${renewResult.message}`);
          }
          await sleep(800);
        }
        send("全部完成");
        send(`✅ 本次总计续费成功：${renewSuccessCount} 个域名`);
      } catch (e) {
        send(`异常：${e.message}`);
      } finally {
        controller.close();
      }
    }
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function pageHtml() {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>DNSHE 域名自动续期</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:system-ui}
body{background:#f0f2f5;padding:20px}
.container{max-width:900px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 2px 12px #00000014}
h1{font-size:22px;margin-bottom:16px;color:#222}
#runBtn{width:100%;padding:14px;font-size:16px;background:#2563eb;color:#fff;border:0;border-radius:8px;cursor:pointer}
#log{margin-top:16px;white-space:pre-wrap;background:#ffffff;color:#222;padding:16px;border:1px solid #e5e7eb;border-radius:8px;min-height:400px;overflow:auto;font-family:Consolas,monospace;font-size:14px}
</style>
</head>
<body>
<div class="container">
  <h1>DNSHE 域名自动续期运行面板</h1>
  <button id="runBtn">开始执行</button>
  <div id="log"></div>
</div>
<script>
const btn = document.getElementById('runBtn');
const logBox = document.getElementById('log');
btn.onclick = async () => {
  btn.disabled = true;
  logBox.textContent = "";
  const es = new EventSource("/run");
  es.onmessage = e => {
    const msg = JSON.parse(e.data);
    logBox.textContent += msg + "\\n";
    logBox.scrollTop = logBox.scrollHeight;
  };
  es.onerror = () => {
    es.close();
    btn.disabled = false;
  }
}
</script>
</body>
</html>
`;
}
