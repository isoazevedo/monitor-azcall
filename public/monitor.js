// monitor.js integrado

const peersContainer = document.getElementById("peersContainer");
const trunksContainer = document.getElementById("trunksContainer");
const callsContainer = document.getElementById("callsContainer");
const statusEl = document.getElementById("status");
const statusIndicator = document.getElementById("statusIndicator");

const state = {
    peers: new Map(),
    trunks: new Map(),
    calls: new Map(),
};

// --- Conexão WebSocket ---
const protocol = location.protocol === "https:" ? "wss://" : "ws://";
const wsUrl = `${protocol}${location.host}/monitor`;

let ws;
let reconnectAttempts = 0;
const maxReconnect = 10;

function connectWS() {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        reconnectAttempts = 0;
        statusEl.textContent = "Conectado";
        statusIndicator.style.background = "var(--success)";
        console.log("[Monitor] WebSocket conectado");
    };

    ws.onmessage = (msg) => {
        try {
            const payload = JSON.parse(msg.data);
            if (payload.event && payload.data) {
                handleEvent(payload.event, payload.data);
            }
        } catch (e) {
            console.error("Erro ao processar evento:", e);
        }
    };

    ws.onclose = () => {
        if (reconnectAttempts < maxReconnect) {
            reconnectAttempts++;
            statusEl.textContent = `Reconectando (${reconnectAttempts})...`;
            statusIndicator.style.background = "var(--warning)";
            console.warn(`[Monitor] WS desconectado. Tentando reconectar (${reconnectAttempts})...`);
            setTimeout(connectWS, 3000);
        } else {
            statusEl.textContent = "Desconectado";
            statusIndicator.style.background = "var(--danger)";
            console.error("[Monitor] Falha após múltiplas tentativas de reconexão.");
        }
    };

    ws.onerror = (err) => {
        console.error("[Monitor] Erro WebSocket:", err.message || err);
        ws.close();
    };
}

connectWS();

// --- Manipulação dos eventos AMI ---
function handleEvent(event, data) {
    switch (event) {
        case "InitialState":
            state.peers = new Map(Object.entries(data.peers || {}));
            state.trunks = new Map(Object.entries(data.trunks || {}));
            state.calls = new Map(Object.entries(data.calls || {}));
            renderPeers();
            renderTrunks();
            renderCalls();
            break;
        case "PeerStatus":
            for (const [id, peerData] of Object.entries(data.peers)) {
                state.peers.set(id, peerData);
            }
            renderPeers();
            break;
        case "Registry":
            for (const [id, trunksData] of Object.entries(data.trunks)) {
                state.trunks.set(id, trunksData);
            }
            renderTrunks();
            break;
        case "NewCall":
        case "CallEnded":
            const delCalls = Array.from(state.calls.entries()).filter(([id, p]) => p.channel === data.channel);
            delCalls.sort((a, b) => (a[0] + "").localeCompare(b[0] + ""));
            delCalls.map(([id, p]) => {
                console.log(`ID:`, id);
                state.calls.delete(id);
            });
            renderCalls();
            break;
        case "CallState":
            for (const [id, callsData] of Object.entries(data.calls)) {
                console.log(`CallState: Atualizando chamada ${id}`, callsData);
                state.calls.set(id, callsData);
            }
            console.log(state.calls);
            renderCalls();
            break;
        case "BridgeEnter":
        case "BridgeLeave":
            renderCalls();
            break;
    }
}

// --- Renderização ---
function renderPeers() {
    if (!state.peers.size) {
        peersContainer.innerHTML = `
            <div class="empty-state">
                <i class="bx bx-user-x"></i>
                <div class="empty-state-text">Nenhum ramal detectado</div>
            </div>`;
        return;
    }

    const peers = Array.from(state.peers.entries()).filter(([id, p]) => p.type === "EXTEN");
    peers.sort((a, b) => (a[0] + "").localeCompare(b[0] + ""));

    peersContainer.innerHTML = `<div class="row g-3">` +
        peers.map(([id, p]) => {
            const cls = /ok|online|up|not in use/i.test(p.status) ? "online" :
                /unreachable|unreg/i.test(p.status) ? "offline" :
                    /busy|ring/i.test(p.status) ? "busy" : "idle";

            const badgeClass = cls === "online" ? "bg-success" :
                cls === "offline" ? "bg-danger" :
                    cls === "busy" ? "bg-warning text-dark" : "bg-secondary";

            return `
            <div class="col-xl-4 col-md-6">
                <div class="peer-card ${cls}">
                    <div class="peer-info">
                        <div class="peer-icon">
                            <i class="bx bx-user"></i>
                        </div>
                        <div class="peer-name">${id}</div>
                    </div>
                    <div class="peer-status-wrapper">
                        <span class="peer-tech">${p.tech || "SIP"}</span>
                        <span class="badge ${badgeClass}">${p.status}</span>
                    </div>
                </div>
            </div>`;
        }).join("") +
        `</div>`;
}

function renderTrunks() {
    if (!state.trunks.size) {
        trunksContainer.innerHTML = `
            <div class="empty-state" style="padding: 2rem 1rem;">
                <i class="bx bx-plug"></i>
                <div class="empty-state-text">Nenhum tronco detectado</div>
            </div>`;
        return;
    }

    const trunks = Array.from(state.trunks.entries()).filter(([id, p]) => p.type === "TRUNK");
    trunks.sort((a, b) => (a[0] + "").localeCompare(b[0] + ""));

    console.log(state.trunks.size);

    trunksContainer.innerHTML = trunks.map(([id, p]) => `
        <div class="trunk-item">
            <div class="trunk-info">
                <div class="trunk-icon">
                    <i class="bx bx-plug"></i>
                </div>
                <div class="trunk-name">${id}</div>
            </div>
            <div class="trunk-status-wrapper">
                <span class="trunk-tech">${p.tech || "SIP"}</span>
                <span class="badge ${/registered|ok/i.test(p.status) ? 'bg-success' : 'bg-danger'}">
                    ${p.status}
                </span>
            </div>
        </div>
    `).join("");
}

function renderCalls() {
    if (!state.calls.size) {
        callsContainer.innerHTML = `
            <div class="empty-state" style="padding: 2rem 1rem;">
                <i class="bx bx-phone-off"></i>
                <div class="empty-state-text">Sem chamadas ativas</div>
            </div>`;
        return;
    }

    const stateMap = {
        "DOWN": "Chamando",
        "RINGING": "Chamando",
        "BUSY": "Chamando",
        "UP": "Ativa",
        "HOLD": "Em Espera",
        "BRIDGE": "Em Conferência",
        "DISCONNECTED": "Encerrada",
        "TRANSFER": "Transferida",
        "QUEUED": "Em Fila",
        "ABANDONED": "Abandonada",
        "UNKNOWN": "Desconhecida"
    };


    const clss = Array.from(state.calls.entries()).filter(([id, p]) => p.type === "TRUNK");
    clss.sort((a, b) => (a[0] + "").localeCompare(b[0] + ""));

    const calls = Array.from(state.calls.values());
    callsContainer.innerHTML = calls.map(c => {

        const callState = (c.state || "UP").toUpperCase();
        const displayState = stateMap[callState] || "Ativa";
        const badgeClass = callState === "UP" ? "bg-success" :
            callState === "HOLD" ? "bg-warning text-dark" :
                callState === "BRIDGE" ? "bg-primary" :
                    callState === "DISCONNECTED" ? "bg-secondary" :
                        callState === "TRANSFER" ? "bg-info text-dark" :
                            callState === "QUEUED" ? "bg-dark" :
                                callState === "ABANDONED" ? "bg-danger" :
                                    "bg-secondary";

        return `
        <div class="call-item">
            <div class="call-info">
                <div class="call-icon">
                    <i class="bx bx-phone"></i>
                </div>
                <div class="call-number">${c.src || "Anônimo"} &nbsp;&nbsp; <i class="bi bi-arrow-right"></i> &nbsp;&nbsp; ${c.dst || "Anônimo"}</div>
            </div>
            <span class="badge ${badgeClass}">${displayState}</span>
        </div>
    `;
    }).join("");
}