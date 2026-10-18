import { ALERTS, API, BMC, alertsOn } from "./api.js";

const $ = (id) => document.getElementById(id);
$("privacy").href = API + "/privacy";
$("security").href = API + "/security";
if (BMC.startsWith("https://")) { $("bmc").href = BMC; $("bmc-wrap").hidden = false; }

const showOn = () => { $("alerts").innerHTML = `<span class="ok">✓ Alerts are on</span>`; };

if (await alertsOn()) showOn();
else $("on").addEventListener("click", async () => {
  // Chrome shows its own permission prompt here.
  if (await chrome.permissions.request(ALERTS)) showOn();
  else $("on").textContent = "Turn on alerts (you can also do this later from the icon)";
});
