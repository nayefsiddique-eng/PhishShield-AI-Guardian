/**
 * PhishShield AI - Manifest V3 Service Worker
 */

const CONFIG = {
  apiEndpoint: "https://phishshield-ai-guardian-production.up.railway.app/predict",
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    lastCheckedDomain: "Initialization Node",
    lastThreatScore: 0,
    lastThreatFlags: ["System Ready"]
  });
  console.log("[PhishShield AI] Background service engine successfully mounted.");
});

const pendingRequests = new Set();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "EVALUATE_SECURITY_TELEMETRY") {
    const data = message.telemetryData;
    const domain = typeof data?.domainName === "string" ? data.domainName : "";
    let url;
    try {
      url = new URL(sender.tab?.url || data?.pageUrl || ("http://" + domain));
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported protocol");
    } catch (_) {
      sendResponse({ riskScore: 0, triggeredMitigations: ["Unsupported URL"] });
      return;
    }

    let computedRiskScore = 0;
    let activatedAlertFlags = [];
    if (url.username || url.password) {
      computedRiskScore += 30;
      activatedAlertFlags.push("URL contains embedded credentials");
    }
    if (data?.hasPasswordInput && url.protocol === "http:" && url.hostname !== "127.0.0.1") {
      computedRiskScore += 35;
      activatedAlertFlags.push("Insecure Cleartext Transmission (HTTP + Password Field)");
    }
    url.username = "";
    url.password = "";
    url.hash = "";
    const requestUrl = url.href;
    const requestKey = JSON.stringify([requestUrl, computedRiskScore]);
    if (pendingRequests.has(requestKey)) {
      sendResponse({ riskScore: computedRiskScore, triggeredMitigations: [...activatedAlertFlags, "Scan already in progress"] });
      return;
    }
    pendingRequests.add(requestKey);

    fetch(CONFIG.apiEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: requestUrl }),
      signal: AbortSignal.timeout(10000)
    })
      .then((res) => {
        if (!res.ok) throw new Error(`Backend returned ${res.status}`);
        return res.json();
      })
      .then((backendResult) => {
        const backendScore =
          typeof backendResult.score === "number"
            ? backendResult.score
            : (backendResult.backendRiskScore || 0);
        const backendFlags = Array.isArray(backendResult.flags)
          ? backendResult.flags
          : (backendResult.backendFlags || []);

        // Backend score is authoritative. Local HTTP penalty is additive, capped at 100.
        if (backendResult.status !== "SAFE" && backendResult.whitelist !== true) {
          computedRiskScore = Math.min(backendScore + computedRiskScore, 100);
          activatedAlertFlags = [...activatedAlertFlags, ...backendFlags];
        }
        console.log("[PhishShield]", domain, "| flags:", activatedAlertFlags);

        chrome.storage.local.set({
          lastCheckedDomain: domain,
          lastThreatScore: computedRiskScore,
          lastThreatFlags: activatedAlertFlags
        });

        sendResponse({ riskScore: computedRiskScore, triggeredMitigations: activatedAlertFlags });
      })
      .catch((err) => {
        console.warn("[PhishShield AI] Backend unreachable. Falling back to local rules.", err);

        chrome.storage.local.set({
          lastCheckedDomain: domain,
          lastThreatScore: computedRiskScore,
          lastThreatFlags: [...activatedAlertFlags, "Offline Mode: Local Rules Only"]
        });

        sendResponse({ riskScore: computedRiskScore, triggeredMitigations: [...activatedAlertFlags, "Offline Mode: Local Rules Only"] });
      })
      .finally(() => {
        pendingRequests.delete(requestKey);
      });

    return true; // Keep Chrome message channel alive for async response
  }
});
