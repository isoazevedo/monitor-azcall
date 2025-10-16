/**
 * Monitor Azcall3 — Serviço em tempo real
 * Versão com @ipcom/asterisk-ami e WebSocket nativo
 * Autor: Israel Azevedo (Aztell Soluções em telefonia IP)
 */

import dotenv from "dotenv";
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import {eAmi as AmiClient} from "@ipcom/asterisk-ami";
import { fileURLToPath } from "url";
import path from "path";

// =====================
//  DEPENDÊNCIAS
// =====================

dotenv.config();

// =====================
//  CONFIGURAÇÕES
// =====================

const PORT = process.env.PORT || 5120;
const AMI_HOSTS = (process.env.AMI_HOSTS || "127.0.0.1").split(",");
const AMI_PORT = process.env.AMI_PORT || 5038;
const AMI_USER = process.env.AMI_USER || "admin";
const AMI_PASS = process.env.AMI_PASS || "admin";

const app = express();
const server = http.createServer(app);

// 🔧 Ajuste do caminho absoluto pro diretório public
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =====================
//  WEBSOCKET SERVER
// =====================
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
    console.log("[Monitor] Novo cliente WebSocket conectado");
    ws.send(JSON.stringify({ event: "hello", message: "Monitor conectado!" }));
});

// broadcast para todos os clientes conectados
function broadcast(event, data) {
    const payload = JSON.stringify({ event, data, ts: Date.now() });
    wss.clients.forEach((client) => {
        if (client.readyState === 1) client.send(payload);
    });
}

// =====================
//  ESTADO EM MEMÓRIA
// =====================
const state = {
    peers: new Map(), // ramais
    trunks: new Map(), // troncos
    trunksIAX: new Map(), // troncos
    calls: new Map(), // chamadas ativas
};

// =====================
//  CONEXÃO AMI
// =====================
for (const host of AMI_HOSTS) {
    console.log('====================');
    console.log(host)
    console.log('====================');

    const ami = new AmiClient({
        host: host,
        port: Number(AMI_PORT),
        userName: AMI_USER,
        password: AMI_PASS,
        additionalOptions: {
            debug: false,
            reconnect: true,     // reconecta automaticamente em caso de queda
            keepAlive: true,     // mantém sessão viva com PING/PONG
            emitAllEvents: true,    // permite capturar eventos nativos do AMI
            resendAction: false,
            timeout: 5000        // timeout padrão para ações
        },
    });

    ami.connect();

    ami.events.on("connect", async () => {
        console.log(`[AMI] Conectado a ${host}:${AMI_PORT}`);
        // Limpa estado antigo
        state.peers.clear();
        state.calls.clear();
        state.trunks.clear();

        setTimeout(async function() {
            // --- 1. Solicita lista de peers (ramais)
            try {
                const peers = await ami.action({
                    Action: "PJSIPShowEndpoints",
                });
            } catch (err) {
                console.error(`[AMI] Falha ao atualizar endpoints:`, err.message);
            }

            try {
                const peers = await ami.action({
                    Action: "SIPpeers",
                });
            } catch (err) {
                console.error(`[AMI] Falha ao atualizar endpoints:`, err.message);
            }

            // --- 2. Solicita registros (troncos)
            try {
                const regs = await ami.action({
                    Action: "PJSIPShowRegistrationsOutbound",
                });
            } catch (err) {
                console.error(`[AMI] Falha ao listar registros em ${host}:`, err.message);
            }


            // --- 3. (opcional) Lista chamadas em curso
            try {
                const chans = await ami.action({
                    Action: "CoreShowChannels",
                });

            } catch (err) {
                console.error(`[AMI] Falha ao listar chamadas:`, err.message);
            }

            // --- 4. (opcional) Solicita troncos IAX2
            try {
                const iaxTrunks = await ami.action({
                    Action: "IAXpeerlist",
                });
            } catch (err) {
                console.error(`[AMI] Falha ao listar troncos IAX2:`, err.message);
            }

            // Notifica o front de tudo que foi carregado
            broadcast("InitialState", {
                peers: Object.fromEntries(state.peers),
                calls: Object.fromEntries(state.calls),
                trunks: Object.fromEntries(state.trunks),
            });
        }, 3000);
    });

    ami.events.on("reconnect", () => console.log(`[AMI] Reconectando a ${host}...`));
    ami.events.on("disconnect", () => console.log(`[AMI] Desconectado de ${host}`));
    ami.events.on("error", (err) => console.error(`[AMI] Erro em ${host}:`, err.message));

    ami.events.on("EndpointList", (evt) => {
        if (evt.OutboundAuths === 0) {
            const id = evt.ObjectName || evt.Endpoint || evt.Username;
            const status = evt.DeviceState || "Unknown";
            if (id) {
                state.peers.set(id, {status, tech: "PJSIP", type: "EXTEN", host, lastSeen: Date.now()});

            }
        }
    });

    ami.events.on("EndpointListComplete", (evt) => {
        // console.log(`[AMI] Carregados ${state.peers.size} peers PJSIP`);
        broadcast("PeerStatus", {
            peers: Object.fromEntries(state.peers)

        });
    });

    // --- Nova chamada
    // ami.events.on("Newchannel", (evt) => {
    //     const uid = evt.Uniqueid;
    //     if (!uid) return;
    //     // filtrar chamadas pelo ChannelStateDesc Ring ou Dialing
    //     if (!['Ring', 'Dialing', 'Ringing'].includes(evt.ChannelStateDesc)) {
    //         return;
    //     }
    //
    //     state.calls.set(uid, {
    //         dst: evt.CallerIDNum || evt.CallerIDName || "Anônimo",
    //         src: evt.ConnectedLineNum || evt.ConnectedLineName || evt.Exten || "",
    //         channel: evt.Channel,
    //         state: evt.ChannelStateDesc || "Active",
    //         startedAt: Date.now(),
    //         host,
    //     });
    //
    //     broadcast("NewCall", state.calls.get(uid));
    //
    // });

    // --- Hangup (chamada finalizada)
    ami.events.on("Hangup", (evt) => {
        const channel = evt.Channel;
        const uid = evt.Uniqueid;
        if (!uid) return;

        const call = state.calls.get(uid);

        if (call && call.channel === channel) {
            call.endedAt = Date.now();
            broadcast("CallEnded", call);
            state.calls.delete(uid);
        }

    });

    // --- Registry (troncos / gateways)
    ami.events.on("Registry", (evt) => {
        const trunk = evt.Channel || evt.Domain || evt.Username || evt.Host;
        const status = evt.Status || evt.Message || evt.ReplyText;
        if (!trunk) return;

        state.trunks.set(trunk, { status: `${status || ""}`, host });
        broadcast("Registry", { trunk, status });
    });

    ami.events.on("OutboundRegistrationDetail", (evt) => {
        const trunk = evt.ObjectName || evt.Domain || evt.Username || evt.Host;
        const status = evt.Status || evt.Message || evt.ReplyText;
        if (!trunk) return;

        state.trunks.set(trunk, { status: `${status || ""}`, host, tech: "PJSIP", type: "TRUNK", lastSeen: Date.now() });
    });

    ami.events.on("PeerEntry", (evt) => {
        if (evt.Channeltype === "IAX") { // garante que é IAX
            const endpoint = evt.ObjectName || evt.Peer || evt.Username;
            if (!endpoint) return;

            const status = evt.Status || "Unknown";
            state.trunks.set(endpoint, {
                status,
                tech: "IAX",
                type: "TRUNK",
                host,
                lastSeen: Date.now(),
            });
        } else if (evt.Channeltype === "SIP") {

            if (evt.Description === 'trunk') {
            const endpoint = evt.ObjectName || evt.Peer || evt.Username;
            if (!endpoint) return;

            const status = evt.Status || "Unknown";
            state.trunks.set(endpoint, {
                status,
                tech: "SIP",
                type: "TRUNK",
                host,
                lastSeen: Date.now(),
            });
            } else {
                const endpoint = evt.ObjectName || evt.Peer || evt.Username;
                if (!endpoint) return;

                const status = evt.Status || "Unknown";
                state.peers.set(endpoint, {
                    status,
                    tech: "SIP",
                    type: "EXTEN",
                    host,
                    lastSeen: Date.now(),
                });
            }
        }
    });

    ami.events.on("PeerlistComplete", (evt) => {
        broadcast("Registry", {
            trunks: Object.fromEntries(state.trunks)
        });

    });

    // Cada canal ativo vem aqui
    ami.events.on("CoreShowChannel", (evt) => {
        const uid = evt.Uniqueid;
        if (!uid) return;
        if (evt.Application && !['AppDial', 'Queue', 'ChanSpy', 'Playback', 'BackGround', 'Transfer', 'BindTransfer'].includes(evt.Application)) {
            return;
        }
        state.calls.set(uid, {
            dst: evt.CallerIDNum || evt.CallerIDName || "Anônimo",
            src: evt.ConnectedLineNum || evt.ConnectedLineName || evt.Exten || "",
            channel: evt.Channel,
            state: evt.ChannelStateDesc || "Active",
            startedAt: Date.now(),
            host,
        });
    });

// Quando terminar de enviar todos os canais
    ami.events.on("CoreShowChannelsComplete", (evt) => {
        // console.log(`[AMI] Carregados ${state.calls.size} canais ativos de ${host}`);
        broadcast("CallState", {
            calls: Object.fromEntries(state.calls),
        });
    });


    // carregar eventos para debug (sem filtro)
    // ami.events.on('events', (evt) => {
    //     console.log('AMI EVENT:', evt);
    // });

// =====================
//  CICLO DE ATUALIZAÇÃO
// =====================

    setInterval(async () => {
        try {
            const peers = await ami.action({
                Action: "PJSIPShowEndpoints",
            });
        }
        catch (err) {
            console.error(`[AMI] Falha ao atualizar endpoints:`, err.message);
        }

        try {
            const peers = await ami.action({
                Action: "SIPpeers",
            });
        }
        catch (err) {
            console.error(`[AMI] Falha ao atualizar endpoints:`, err.message);
        }

        // --- 2. Solicita registros (troncos)
        try {
            const regs = await ami.action({
                Action: "PJSIPShowRegistrationsOutbound",
            });
        } catch (err) {
            console.error(`[AMI] Falha ao listar registros em ${host}:`, err.message);
        }


        // --- 3. (opcional) Lista chamadas em curso
        try {
            const chans = await ami.action({
                Action: "CoreShowChannels",
            });

        } catch (err) {
            console.error(`[AMI] Falha ao listar chamadas:`, err.message);
        }

        // --- 4. (opcional) Solicita troncos IAX2
        try {
            const iaxTrunks = await ami.action({
                Action: "IAXpeerlist",
            });
        } catch (err) {
            console.error(`[AMI] Falha ao listar troncos IAX2:`, err.message);
        }


    }, 5000); // a cada 5 segundos

}


// =====================
//  SERVIÇOS ESTÁTICOS
// =====================
app.use(express.static(path.join(__dirname, "public")));

// =====================
//  ENDPOINT DE ESTADO
// =====================
app.get("/status", (req, res) => {
    res.json({
        peers: Object.fromEntries(state.peers),
        calls: Object.fromEntries(state.calls),
        trunks: Object.fromEntries(state.trunks),
        ami_hosts: AMI_HOSTS,
    });
});

// =====================
//  INICIALIZAÇÃO
// =====================
server.listen(PORT, () => {
    console.log(`[Monitor] Servidor WebSocket rodando na porta ${PORT}`);
});
