const TIME_WINDOW_SECONDS = 10;
const defaultMessage = "Transfer Rs.500 to Bob";
const defaultSecret = "my_secure_shared_key";
const usedNonces = new Set();

let currentTransaction = null;
let lastAcceptedTransaction = null;
let capturedTransaction = null;
let receiverReasonText = "No transaction received.";
let simulationStage = "idle";
let isTransmitting = false;
let pinnedWorkstation = "sender";
let logEntries = [];

const elements = {
  systemStatusText: document.getElementById("systemStatusText"),
  statusBox: document.getElementById("statusBox"),
  messageInput: document.getElementById("messageInput"),
  secretInput: document.getElementById("secretInput"),
  displayMessage: document.getElementById("displayMessage"),
  displayTimestamp: document.getElementById("displayTimestamp"),
  displayNonce: document.getElementById("displayNonce"),
  displayHmac: document.getElementById("displayHmac"),
  senderStatus: document.getElementById("senderStatus"),
  attackerMessage: document.getElementById("attackerMessage"),
  attackerTimestamp: document.getElementById("attackerTimestamp"),
  attackerNonce: document.getElementById("attackerNonce"),
  attackerHmac: document.getElementById("attackerHmac"),
  attackerStatus: document.getElementById("attackerStatus"),
  receiverReason: document.getElementById("receiverReason"),
  coreTraffic: document.getElementById("coreTraffic"),
  corePacket: document.getElementById("corePacket"),
  transactionPacket: document.getElementById("transactionPacket"),
  workstations: [...document.querySelectorAll(".workstation")],
  processStages: [...document.querySelectorAll("[data-process-stage]")],
  stationHint: document.getElementById("stationHint"),
  generationBtn: document.getElementById("generateBtn"),
  sendBtn: document.getElementById("sendBtn"),
  resetBtn: document.getElementById("resetBtn"),
  replayBtn: document.getElementById("replayBtn"),
  modifyBtn: document.getElementById("modifyBtn"),
  expiredBtn: document.getElementById("expiredBtn"),
  newTxBtn: document.getElementById("newTxBtn"),
  timestampCheck: document.getElementById("timestampCheck"),
  nonceCheck: document.getElementById("nonceCheck"),
  hmacCheck: document.getElementById("hmacCheck"),
  finalDecision: document.getElementById("finalDecision"),
  flowSummary: document.getElementById("flowSummary"),
  flowScene: document.getElementById("flowScene"),
  stationDialog: document.getElementById("stationDialog"),
  stationDialogTitle: document.getElementById("stationDialogTitle"),
  stationDialogScreen: document.getElementById("stationDialogScreen"),
  closeStationDialog: document.getElementById("closeStationDialog"),
  verificationLog: document.getElementById("verificationLog"),
  runTestButtons: [...document.querySelectorAll(".run-test-btn")],
  attackerReplayBtn: document.getElementById("attackerReplayBtn")
};

function getCurrentUnixTime() {
  return Math.floor(Date.now() / 1000);
}

function formatTime(value) {
  const date = new Date(value * 1000);
  return date.toLocaleTimeString([], { hour12: false });
}

function toHex(bytes) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(Math.ceil(hex.length / 2));
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function safeCompareHex(expectedHex, actualHex) {
  if (typeof expectedHex !== "string" || typeof actualHex !== "string") {
    return false;
  }

  const expectedBytes = hexToBytes(expectedHex);
  const actualBytes = hexToBytes(actualHex);

  if (expectedBytes.length !== actualBytes.length) {
    return false;
  }

  if (window.crypto && crypto.timingSafeEqual) {
    return crypto.timingSafeEqual(expectedBytes, actualBytes);
  }

  let mismatch = 0;
  for (let i = 0; i < expectedBytes.length; i += 1) {
    mismatch |= expectedBytes[i] ^ actualBytes[i];
  }
  return mismatch === 0;
}

function setSystemStatus(mode) {
  const modes = {
    protected: { text: "LAB PROTECTED", className: "status-protected" },
    attack: { text: "ATTACK DETECTED", className: "status-attack" },
    warning: { text: "TIMESTAMP EXPIRED", className: "status-warning" }
  };

  const config = modes[mode] || modes.protected;
  elements.systemStatusText.textContent = config.text;
  elements.statusBox.className = `status-box ${config.className}`;
}

function appendLog(message) {
  const timestamp = new Date().toLocaleTimeString([], { hour12: false });
  logEntries.unshift(`[${timestamp}] ${message}`);
  logEntries = logEntries.slice(0, 18);
  elements.verificationLog.innerHTML = logEntries.map((entry) => `<div>${entry}</div>`).join("");
}

function setBadge(element, state, text) {
  element.textContent = text;
  element.className = element.id === "finalDecision"
    ? `decision-${state}`
    : `check-state ${state}`;
}

function updateActionButtons() {
  const hasCurrentTx = Boolean(currentTransaction);
  const accepted = Boolean(lastAcceptedTransaction);
  elements.generationBtn.disabled = isTransmitting;
  elements.sendBtn.disabled = isTransmitting || !hasCurrentTx;
  elements.replayBtn.disabled = isTransmitting || !accepted || !currentTransaction;
  elements.modifyBtn.disabled = isTransmitting || !hasCurrentTx;
  elements.expiredBtn.disabled = isTransmitting || !hasCurrentTx;
  elements.newTxBtn.disabled = isTransmitting || !hasCurrentTx;
  elements.resetBtn.disabled = isTransmitting;
  elements.attackerReplayBtn.disabled = isTransmitting || !accepted || !currentTransaction;
  elements.runTestButtons.forEach((button) => {
    button.disabled = isTransmitting;
  });
}

function resetFlowAnimation() {
  elements.flowScene.classList.remove("sending");
  elements.flowScene.dataset.route = "";
  elements.flowScene.dataset.state = "idle";
}

function highlightFlowState(state) {
  resetFlowAnimation();
  const messages = {
    idle: "Waiting for a valid transaction to be created.",
    created: "Transaction signed by the sender and ready for the isolated network.",
    sending: "Authenticated transaction moving from sender through the network.",
    captured: "Attacker workstation captured the signed transaction.",
    accepted: "Receiver accepted the transaction after timestamp, nonce, and HMAC checks.",
    attack: "Replay attack detected: the receiver rejected a previously used nonce.",
    rejected: "Receiver rejected the transaction after a security check failed."
  };
  const sceneStates = { attack: "attack", rejected: "rejected", accepted: "accepted" };
  elements.flowScene.dataset.state = sceneStates[state] || state;
  elements.flowSummary.textContent = messages[state] || messages.idle;
  renderStationScreens();
}

function renderCurrentTransaction() {
  if (!currentTransaction) {
    elements.displayMessage.textContent = "—";
    elements.displayTimestamp.textContent = "—";
    elements.displayNonce.textContent = "—";
    elements.displayHmac.textContent = "—";
    renderStationScreens();
    return;
  }

  elements.displayMessage.textContent = currentTransaction.message;
  elements.displayTimestamp.textContent = String(currentTransaction.timestamp);
  elements.displayNonce.textContent = currentTransaction.nonce;
  elements.displayHmac.textContent = currentTransaction.hmac;
  renderStationScreens();
}

function renderStationScreens() {
  const captured = capturedTransaction;
  elements.senderStatus.textContent = currentTransaction ? "TRANSACTION SIGNED" : "AWAITING TRANSACTION";
  elements.attackerMessage.textContent = captured ? captured.message : "No packet captured";
  elements.attackerTimestamp.textContent = captured ? String(captured.timestamp) : "—";
  elements.attackerNonce.textContent = captured ? captured.nonce : "—";
  elements.attackerHmac.textContent = captured ? captured.hmac : "—";

  const attackerStates = {
    idle: "SNIFFER STANDBY",
    created: "WAITING FOR NETWORK TRAFFIC",
    sending: "PACKET IN TRANSIT",
    captured: "TRANSACTION CAPTURED",
    replay: "REPLAYING CAPTURED PACKET",
    modified: "PAYLOAD MODIFIED · ORIGINAL TAG",
    expired: "STALE PACKET INJECTED",
    verifying: "PACKET SENT TO RECEIVER",
    accepted: "TRAFFIC OBSERVED · NO REPLAY",
    rejected: "ATTACK REJECTED BY RECEIVER"
  };
  elements.attackerStatus.textContent = attackerStates[simulationStage] || attackerStates.idle;
  elements.receiverReason.textContent = receiverReasonText;

  const coreStates = {
    idle: ["IDLE", "NONE"],
    created: ["SIGNED", "READY TO SEND"],
    sending: ["ROUTING", "AUTHENTICATED"],
    captured: ["CAPTURED", "COPY STORED"],
    replay: ["REPLAY ROUTE", "REUSED NONCE"],
    modified: ["TAMPERED", "MESSAGE ALTERED"],
    expired: ["STALE PACKET", "TIMESTAMP -30S"],
    verifying: ["VERIFYING", currentTransaction ? `NONCE ${currentTransaction.nonce.slice(0, 8)}` : "PENDING"],
    accepted: ["ACCEPTED", "UNIQUE NONCE"],
    attack: ["REPLAY BLOCKED", "NONCE REUSED"],
    rejected: ["REJECTED", "AUTH CHECK FAILED"]
  };
  const [traffic, packet] = coreStates[simulationStage] || coreStates.idle;
  elements.coreTraffic.textContent = traffic;
  elements.corePacket.textContent = packet;
}

function setProcessStage(stage) {
  const stages = ["create", "authenticate", "capture", "replay", "verify", "result"];
  const activeIndex = stages.indexOf(stage);
  elements.processStages.forEach((item, index) => {
    item.classList.toggle("is-current", item.dataset.processStage === stage);
    item.classList.toggle("is-complete", activeIndex > index);
  });
}

function selectWorkstation(name, pin = false) {
  if (pin) {
    pinnedWorkstation = name;
  }
  elements.workstations.forEach((station) => {
    station.classList.toggle("is-active", station.dataset.workstation === name);
  });
  const names = {
    sender: "Sender · creates and authenticates the packet",
    attacker: "Attacker · captures and replays network traffic",
    receiver: "Receiver · validates freshness and authenticity"
  };
  elements.stationHint.lastChild.textContent = ` ${names[name] || names.sender}`;
}

function openWorkstation(name) {
  const workstation = elements.workstations.find((station) => station.dataset.workstation === name);
  if (!workstation) {
    return;
  }

  selectWorkstation(name, true);
  workstation.focus({ preventScroll: true });
  elements.stationDialogTitle.textContent = workstation.querySelector(".station-heading h2").textContent;

  const expandedScreen = workstation.querySelector(".monitor-screen").cloneNode(true);
  expandedScreen.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
  elements.stationDialogScreen.replaceChildren(expandedScreen);

  const replayButton = expandedScreen.querySelector(".screen-action");
  if (replayButton) {
    replayButton.disabled = elements.attackerReplayBtn.disabled;
    replayButton.addEventListener("click", () => {
      elements.stationDialog.close();
      handleReplaySameTransaction();
    });
  }

  elements.stationDialog.showModal();
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function transmitTransaction(origin = "sender", attackType = "normal") {
  if (!currentTransaction) {
    return;
  }

  isTransmitting = true;
  updateActionButtons();
  simulationStage = attackType === "normal" ? "sending" : attackType;
  elements.flowScene.dataset.route = origin;
  elements.flowScene.dataset.state = "sending";
  elements.flowScene.classList.remove("sending");
  void elements.flowScene.offsetWidth;
  elements.flowScene.classList.add("sending");
  setProcessStage(attackType === "replay" ? "replay" : "authenticate");
  selectWorkstation(origin === "attacker" ? "attacker" : "sender");
  elements.flowSummary.textContent = origin === "attacker"
    ? "Captured packet replayed from attacker to receiver."
    : "Authenticated transaction moving from sender to attacker to receiver.";
  renderStationScreens();

  await wait(620);
  if (origin !== "attacker") {
    capturedTransaction = { ...currentTransaction };
    simulationStage = attackType === "normal" ? "captured" : attackType;
    setProcessStage("capture");
    selectWorkstation("attacker");
    renderStationScreens();
  }

  await wait(620);
  selectWorkstation("receiver");
  simulationStage = "verifying";
  elements.flowScene.classList.remove("sending");
  elements.flowScene.dataset.state = "verifying";
  setProcessStage("verify");
  elements.flowSummary.textContent = "Packet arrived at the receiver. Running timestamp, nonce, and HMAC checks.";
  renderStationScreens();
  isTransmitting = false;
  updateActionButtons();
}

function generateNonce() {
  const randomBuffer = new Uint8Array(16);
  crypto.getRandomValues(randomBuffer);
  return toHex(randomBuffer);
}

async function generateMac(message, timestamp, nonce, secretKey) {
  const encoder = new TextEncoder();
  const payload = `${message}|${timestamp}|${nonce}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretKey),
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return toHex(new Uint8Array(signature));
}

function resetVerificationStatus() {
  setBadge(elements.timestampCheck, "neutral", "—");
  setBadge(elements.nonceCheck, "neutral", "—");
  setBadge(elements.hmacCheck, "neutral", "—");
  setBadge(elements.finalDecision, "neutral", "Awaiting transaction");
}

function resetLab() {
  usedNonces.clear();
  currentTransaction = null;
  lastAcceptedTransaction = null;
  capturedTransaction = null;
  receiverReasonText = "No transaction received.";
  simulationStage = "idle";
  isTransmitting = false;
  pinnedWorkstation = "sender";
  logEntries = ["[00:00:00] Laboratory ready"];
  elements.verificationLog.innerHTML = logEntries.map((entry) => `<div>${entry}</div>`).join("");
  elements.messageInput.value = defaultMessage;
  elements.secretInput.value = defaultSecret;
  renderCurrentTransaction();
  resetVerificationStatus();
  setSystemStatus("protected");
  highlightFlowState("idle");
  setProcessStage("create");
  selectWorkstation("sender");
  updateActionButtons();
}

async function createTransaction(messageOverride, secretOverride, metaLog = true) {
  const message = String(messageOverride || elements.messageInput.value || defaultMessage).trim();
  const secretKey = String(secretOverride || elements.secretInput.value || defaultSecret).trim();
  const timestamp = getCurrentUnixTime();
  const nonce = generateNonce();
  const hmac = await generateMac(message, timestamp, nonce, secretKey);

  currentTransaction = {
    message,
    timestamp,
    nonce,
    hmac,
    secretKey
  };

  capturedTransaction = null;
  receiverReasonText = "Packet generated; receiver is waiting.";
  simulationStage = "created";
  setProcessStage("authenticate");
  renderCurrentTransaction();
  resetVerificationStatus();
  if (metaLog) {
    appendLog("Transaction created");
    appendLog("Nonce generated");
    appendLog("HMAC-SHA256 generated");
  }
  updateActionButtons();
}

async function verifyTransaction(transaction) {
  if (!transaction) {
    setBadge(elements.finalDecision, "neutral", "No transaction available");
    return false;
  }

  const now = getCurrentUnixTime();
  const timestampDelta = Math.abs(now - Number(transaction.timestamp));
  const timestampValid = timestampDelta <= TIME_WINDOW_SECONDS;
  const nonceAlreadyUsed = usedNonces.has(transaction.nonce);
  const nonceValid = !nonceAlreadyUsed;

  const expectedHmac = await generateMac(
    transaction.message,
    transaction.timestamp,
    transaction.nonce,
    transaction.secretKey || elements.secretInput.value
  );
  const hmacValid = safeCompareHex(expectedHmac, transaction.hmac);

  const finalAccepted = timestampValid && nonceValid && hmacValid;
  setProcessStage("verify");

  setBadge(elements.timestampCheck, timestampValid ? "pass" : "fail", timestampValid ? "PASS" : "FAIL");
  setBadge(elements.nonceCheck, nonceValid ? "pass" : "fail", nonceValid ? "PASS" : "FAIL");
  setBadge(elements.hmacCheck, hmacValid ? "pass" : "fail", hmacValid ? "PASS" : "FAIL");

  if (!timestampValid) {
    setBadge(elements.finalDecision, "fail", "REJECTED — Message expired");
    receiverReasonText = `MESSAGE EXPIRED · age ${timestampDelta}s · allowed window ${TIME_WINDOW_SECONDS}s`;
    simulationStage = "expired";
    setSystemStatus("warning");
    highlightFlowState("rejected");
    setProcessStage("result");
    appendLog("Timestamp validation: FAIL");
    appendLog("Message expired");
    appendLog("Transaction REJECTED");
    updateActionButtons();
    return false;
  }

  if (!nonceValid) {
    setBadge(elements.finalDecision, "fail", "REJECTED — Replay attack detected");
    receiverReasonText = "NONCE ALREADY USED · replay packet rejected.";
    simulationStage = "attack";
    setSystemStatus("attack");
    highlightFlowState("attack");
    setProcessStage("result");
    appendLog("Timestamp validation: PASS");
    appendLog("Nonce validation: FAIL");
    appendLog("REPLAY ATTACK DETECTED");
    appendLog("Transaction REJECTED");
    updateActionButtons();
    return false;
  }

  if (!hmacValid) {
    setBadge(elements.finalDecision, "fail", "REJECTED — Invalid authentication");
    receiverReasonText = "INVALID AUTHENTICATION · HMAC does not match the message.";
    simulationStage = "rejected";
    setSystemStatus("attack");
    highlightFlowState("rejected");
    setProcessStage("result");
    appendLog("Timestamp validation: PASS");
    appendLog("Nonce validation: PASS");
    appendLog("HMAC validation: FAIL");
    appendLog("Transaction REJECTED");
    updateActionButtons();
    return false;
  }

  usedNonces.add(transaction.nonce);
  lastAcceptedTransaction = { ...transaction };
  setBadge(elements.finalDecision, "pass", "ACCEPTED — Transaction verified");
  receiverReasonText = "TIMESTAMP, NONCE, AND HMAC VALID · transaction accepted.";
  simulationStage = "accepted";
  setSystemStatus("protected");
  highlightFlowState("accepted");
  setProcessStage("result");
  appendLog("Timestamp validation: PASS");
  appendLog("Nonce validation: PASS");
  appendLog("HMAC validation: PASS");
  appendLog("Transaction ACCEPTED");
  updateActionButtons();
  return true;
}

async function handleGenerateTransaction() {
  await createTransaction(elements.messageInput.value, elements.secretInput.value, true);
  setSystemStatus("protected");
  highlightFlowState("created");
  resetVerificationStatus();
  updateActionButtons();
}

async function handleSendTransaction() {
  if (!currentTransaction) {
    return;
  }

  appendLog("Transaction sent to receiver");
  await transmitTransaction("sender", "normal");
  await verifyTransaction(currentTransaction);
}

async function handleReplaySameTransaction() {
  if (!lastAcceptedTransaction) {
    return;
  }

  currentTransaction = { ...lastAcceptedTransaction };
  capturedTransaction = { ...lastAcceptedTransaction };
  simulationStage = "replay";
  renderCurrentTransaction();
  appendLog("Captured transaction replayed");
  await transmitTransaction("attacker", "replay");
  await verifyTransaction(currentTransaction);
}

async function handleModifyMessage() {
  if (!lastAcceptedTransaction && !currentTransaction) {
    return;
  }

  const original = lastAcceptedTransaction || currentTransaction;
  const modifiedMessage = "Transfer Rs.5000 to Bob";
  const tamperedTx = {
    message: modifiedMessage,
    timestamp: original.timestamp,
    nonce: generateNonce(),
    hmac: original.hmac,
    secretKey: original.secretKey || elements.secretInput.value
  };

  currentTransaction = tamperedTx;
  capturedTransaction = { ...tamperedTx };
  simulationStage = "modified";
  renderCurrentTransaction();
  appendLog("Message tampering attempt detected");
  appendLog("Original HMAC retained with modified message");
  await transmitTransaction("attacker", "modified");
  await verifyTransaction(tamperedTx);
}

async function handleExpiredTransaction() {
  const original = lastAcceptedTransaction || currentTransaction;
  const expiredTimestamp = getCurrentUnixTime() - 30;
  const secretKey = original ? original.secretKey || elements.secretInput.value : elements.secretInput.value;
  const message = original ? original.message : elements.messageInput.value || defaultMessage;
  const nonce = generateNonce();
  const expiredTx = {
    message,
    timestamp: expiredTimestamp,
    nonce,
    hmac: await generateMac(message, expiredTimestamp, nonce, secretKey),
    secretKey
  };

  currentTransaction = expiredTx;
  capturedTransaction = { ...expiredTx };
  simulationStage = "expired";
  renderCurrentTransaction();
  appendLog("Expired timestamp transaction crafted");
  await transmitTransaction("attacker", "expired");
  await verifyTransaction(expiredTx);
}

async function handleNewValidTransaction() {
  const message = "Transfer Rs.900 to Charlie";
  elements.messageInput.value = message;
  await createTransaction(message, elements.secretInput.value, true);
  setSystemStatus("protected");
  await transmitTransaction("sender", "normal");
  const result = await verifyTransaction(currentTransaction);
  if (result) {
    setBadge(elements.timestampCheck, "pass", "PASS");
    setBadge(elements.nonceCheck, "pass", "PASS");
    setBadge(elements.hmacCheck, "pass", "PASS");
    setBadge(elements.finalDecision, "pass", "ACCEPTED — Transaction verified");
    simulationStage = "accepted";
    highlightFlowState("accepted");
    setProcessStage("result");
  }
}

async function runTestCase(testName) {
  const caseMap = {
    normal: async () => {
      const message = "Transfer Rs.500 to Bob";
      elements.messageInput.value = message;
      await createTransaction(message, elements.secretInput.value, true);
      await transmitTransaction("sender", "normal");
      await verifyTransaction(currentTransaction);
    },
    replay: async () => {
      if (!lastAcceptedTransaction) {
        await runTestCase("normal");
      }
      currentTransaction = { ...lastAcceptedTransaction };
      capturedTransaction = { ...lastAcceptedTransaction };
      simulationStage = "replay";
      renderCurrentTransaction();
      appendLog("Captured transaction replayed");
      await transmitTransaction("attacker", "replay");
      await verifyTransaction(currentTransaction);
    },
    modified: async () => {
      const original = lastAcceptedTransaction || currentTransaction;
      const modifiedTx = {
        message: "Transfer Rs.5000 to Bob",
        timestamp: original ? original.timestamp : getCurrentUnixTime(),
        nonce: generateNonce(),
        hmac: original ? original.hmac : "",
        secretKey: original ? original.secretKey || elements.secretInput.value : elements.secretInput.value
      };
      currentTransaction = modifiedTx;
      capturedTransaction = { ...modifiedTx };
      simulationStage = "modified";
      renderCurrentTransaction();
      appendLog("Message tampering attempt detected");
      appendLog("Original HMAC retained with modified message");
      await transmitTransaction("attacker", "modified");
      await verifyTransaction(modifiedTx);
    },
    expired: async () => {
      const expiredTimestamp = getCurrentUnixTime() - 30;
      const expiredTx = {
        message: "Transfer Rs.500 to Bob",
        timestamp: expiredTimestamp,
        nonce: generateNonce(),
        hmac: await generateMac("Transfer Rs.500 to Bob", expiredTimestamp, generateNonce(), elements.secretInput.value),
        secretKey: elements.secretInput.value
      };
      expiredTx.nonce = generateNonce();
      expiredTx.hmac = await generateMac(expiredTx.message, expiredTx.timestamp, expiredTx.nonce, expiredTx.secretKey);
      currentTransaction = expiredTx;
      capturedTransaction = { ...expiredTx };
      simulationStage = "expired";
      renderCurrentTransaction();
      appendLog("Expired timestamp transaction crafted");
      await transmitTransaction("attacker", "expired");
      await verifyTransaction(expiredTx);
    },
    newTx: async () => {
      const tx = {
        message: "Transfer Rs.900 to Charlie",
        timestamp: getCurrentUnixTime(),
        nonce: generateNonce(),
        secretKey: elements.secretInput.value
      };
      tx.hmac = await generateMac(tx.message, tx.timestamp, tx.nonce, tx.secretKey);
      currentTransaction = tx;
      capturedTransaction = null;
      simulationStage = "created";
      renderCurrentTransaction();
      appendLog("New transaction generated");
      await transmitTransaction("sender", "normal");
      await verifyTransaction(tx);
    }
  };

  if (caseMap[testName]) {
    await caseMap[testName]();
  }
}

document.getElementById("generateBtn").addEventListener("click", handleGenerateTransaction);
document.getElementById("sendBtn").addEventListener("click", handleSendTransaction);
document.getElementById("resetBtn").addEventListener("click", resetLab);
document.getElementById("replayBtn").addEventListener("click", handleReplaySameTransaction);
document.getElementById("modifyBtn").addEventListener("click", handleModifyMessage);
document.getElementById("expiredBtn").addEventListener("click", handleExpiredTransaction);
document.getElementById("newTxBtn").addEventListener("click", handleNewValidTransaction);
elements.attackerReplayBtn.addEventListener("click", handleReplaySameTransaction);

for (const workstation of elements.workstations) {
  const name = workstation.dataset.workstation;
  workstation.addEventListener("pointerenter", () => selectWorkstation(name));
  workstation.addEventListener("pointerleave", () => {
    if (window.matchMedia("(hover: hover)").matches) {
      selectWorkstation(pinnedWorkstation);
    }
  });
  workstation.addEventListener("focusin", () => selectWorkstation(name));
  workstation.addEventListener("click", (event) => {
    if (event.target.closest("button")) {
      return;
    }
    openWorkstation(name);
  });
  workstation.addEventListener("keydown", (event) => {
    if (event.target === workstation && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      openWorkstation(name);
    }
  });
}

elements.closeStationDialog.addEventListener("click", () => elements.stationDialog.close());
elements.stationDialog.addEventListener("click", (event) => {
  if (event.target === elements.stationDialog) {
    elements.stationDialog.close();
  }
});

for (const button of elements.runTestButtons) {
  const row = button.closest("tr");
  const caseName = row ? row.dataset.test : null;

  if (caseName) {
    button.addEventListener("click", () => runTestCase(caseName));
  }
}

resetLab();
