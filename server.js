const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

const DEFAULT_CHANNELS = [
    { name: '📢 Общий', type: 'text' },
    { name: '💬 Флуд', type: 'text' },
    { name: '📎 Важное', type: 'text' }
];

const servers = {
    'general': {
        id: 'general',
        name: 'Общий',
        icon: '🏠',
        creator: 'system',
        createdAt: Date.now(),
        channels: [
            { id: 'general_main', name: '📢 Общий', type: 'text' },
            { id: 'general_offtop', name: '💬 Флуд', type: 'text' },
            { id: 'general_important', name: '📎 Важное', type: 'text' }
        ],
        messages: {}
    },
    'gaming': {
        id: 'gaming',
        name: 'Игровой',
        icon: '🎮',
        creator: 'system',
        createdAt: Date.now(),
        channels: [
            { id: 'gaming_main', name: '🎮 Игровой', type: 'text' },
            { id: 'gaming_lfg', name: '👥 Поиск игры', type: 'text' },
            { id: 'gaming_stats', name: '📊 Статистика', type: 'text' }
        ],
        messages: {}
    },
    'dev': {
        id: 'dev',
        name: 'Разработка',
        icon: '💻',
        creator: 'system',
        createdAt: Date.now(),
        channels: [
            { id: 'dev_main', name: '💻 Разработка', type: 'text' },
            { id: 'dev_ideas', name: '💡 Идеи', type: 'text' },
            { id: 'dev_issues', name: '🐛 Баги', type: 'text' }
        ],
        messages: {}
    }
};

const userProfiles = {};
const clientData = new Map();
const MAX_HISTORY = 100;
const clients = new Set();

function getClientData(ws) {
    if (!clientData.has(ws)) {
        clientData.set(ws, { serverId: 'general', channelId: 'general_main', username: 'Аноним' });
    }
    return clientData.get(ws);
}

function getChannelMessages(serverId, channelId) {
    const server = servers[serverId];
    if (!server) return [];
    if (!server.messages[channelId]) {
        server.messages[channelId] = [];
    }
    return server.messages[channelId];
}

function sendServersList(ws) {
    const data = Object.keys(servers).map(key => ({
        id: servers[key].id,
        name: servers[key].name,
        icon: servers[key].icon,
        creator: servers[key].creator,
        channels: servers[key].channels
    }));

    ws.send(JSON.stringify({
        type: 'servers_list',
        servers: data
    }));
}

function sendChannelHistory(ws, serverId, channelId) {
    const messages = getChannelMessages(serverId, channelId);
    ws.send(JSON.stringify({
        type: 'history',
        serverId: serverId,
        channelId: channelId,
        messages: messages
    }));
}

function broadcastToChannel(serverId, channelId, data, excludeClient = null) {
    const message = JSON.stringify(data);
    clients.forEach((client) => {
        if (client === excludeClient) return;
        if (client.readyState === WebSocket.OPEN) {
            const clientData = getClientData(client);
            if (clientData.serverId === serverId && clientData.channelId === channelId) {
                client.send(message);
            }
        }
    });
}

function broadcastServersList() {
    const data = Object.keys(servers).map(key => ({
        id: servers[key].id,
        name: servers[key].name,
        icon: servers[key].icon,
        creator: servers[key].creator,
        channels: servers[key].channels
    }));

    const message = JSON.stringify({
        type: 'servers_list',
        servers: data
    });

    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

wss.on('connection', (ws) => {
    console.log('🟢 Новый пользователь подключился');
    clients.add(ws);
    
    const data = getClientData(ws);
    data.serverId = 'general';
    data.channelId = 'general_main';

    sendServersList(ws);
    sendChannelHistory(ws, 'general', 'general_main');

    ws.on('message', (rawData) => {
        try {
            const parsed = JSON.parse(rawData);
            const clientData = getClientData(ws);
            
            if (parsed.type === 'message') {
                const { serverId, channelId } = clientData;
                const messages = getChannelMessages(serverId, channelId);
                
                const message = {
                    id: Date.now(),
                    username: parsed.username || clientData.username || 'Аноним',
                    text: parsed.text,
                    time: new Date().toLocaleTimeString(),
                    timestamp: Date.now()
                };

                messages.push(message);
                if (messages.length > MAX_HISTORY) {
                    messages.shift();
                }

                broadcastToChannel(serverId, channelId, {
                    type: 'message',
                    message: message
                }, ws);

            } else if (parsed.type === 'join_channel') {
                const serverId = parsed.serverId;
                const channelId = parsed.channelId;
                
                if (servers[serverId]) {
                    const channel = servers[serverId].channels.find(ch => ch.id === channelId);
                    if (channel) {
                        clientData.serverId = serverId;
                        clientData.channelId = channelId;
                        clientData.username = parsed.username || clientData.username;
                        
                        sendChannelHistory(ws, serverId, channelId);
                        
                        broadcastToChannel(serverId, channelId, {
                            type: 'system',
                            text: `👋 ${clientData.username} присоединился к каналу`
                        }, ws);
                    }
                }

            } else if (parsed.type === 'create_server') {
                const serverId = parsed.serverId || generateId();
                
                if (servers[serverId]) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        text: 'Сервер с таким названием уже существует!'
                    }));
                    return;
                }

                const channels = DEFAULT_CHANNELS.map((ch, index) => ({
                    id: `${serverId}_${index}_${generateId()}`,
                    name: ch.name,
                    type: ch.type
                }));

                servers[serverId] = {
                    id: serverId,
                    name: parsed.name,
                    icon: parsed.icon || '📌',
                    creator: parsed.username || 'user',
                    createdAt: Date.now(),
                    channels: channels,
                    messages: {}
                };

                console.log(`✅ Создан сервер: ${parsed.name} с ${channels.length} каналами`);

                broadcastServersList();

                clientData.serverId = serverId;
                clientData.channelId = channels[0].id;
                
                sendChannelHistory(ws, serverId, channels[0].id);
                
                broadcastToChannel(serverId, channels[0].id, {
                    type: 'system',
                    text: `🏁 Сервер "${parsed.name}" создан! Добро пожаловать!`
                }, ws);

            } else if (parsed.type === 'update_server') {
                const serverId = parsed.serverId;
                const server = servers[serverId];
                
                if (!server) {
                    ws.send(JSON.stringify({ type: 'error', text: 'Сервер не найден!' }));
                    return;
                }
                
                if (server.creator !== 'system' && server.creator !== parsed.username) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        text: 'Только создатель может изменять настройки сервера!'
                    }));
                    return;
                }
                
                if (parsed.name) server.name = parsed.name;
                if (parsed.icon) server.icon = parsed.icon;
                
                broadcastServersList();
                
                ws.send(JSON.stringify({
                    type: 'system',
                    text: `✅ Настройки сервера обновлены!`
                }));

            } else if (parsed.type === 'delete_server') {
                const serverId = parsed.serverId;
                const server = servers[serverId];
                
                if (!server || server.creator === 'system') {
                    ws.send(JSON.stringify({
                        type: 'error',
                        text: 'Нельзя удалить системный сервер!'
                    }));
                    return;
                }
                
                if (server.creator !== parsed.username) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        text: 'Только создатель может удалить этот сервер!'
                    }));
                    return;
                }
                
                const serverName = server.name;
                delete servers[serverId];
                console.log(`🗑️ Удалён сервер: ${serverName}`);
                
                clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        const data = getClientData(client);
                        if (data.serverId === serverId) {
                            data.serverId = 'general';
                            data.channelId = 'general_main';
                            sendChannelHistory(client, 'general', 'general_main');
                        }
                    }
                });
                
                broadcastServersList();
                
                ws.send(JSON.stringify({
                    type: 'system',
                    text: `🗑️ Сервер "${serverName}" был удалён`
                }));

            } else if (parsed.type === 'create_channel') {
                const serverId = parsed.serverId;
                const server = servers[serverId];
                
                if (!server) {
                    ws.send(JSON.stringify({ type: 'error', text: 'Сервер не найден!' }));
                    return;
                }
                
                if (server.creator !== 'system' && server.creator !== parsed.username) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        text: 'Только создатель сервера может создавать каналы!'
                    }));
                    return;
                }
                
                const channel = {
                    id: `${serverId}_${generateId()}`,
                    name: parsed.channelName || '📌 Новый канал',
                    type: 'text'
                };
                
                server.channels.push(channel);
                server.messages[channel.id] = [];
                
                broadcastServersList();
                
                ws.send(JSON.stringify({
                    type: 'system',
                    text: `✅ Создан канал "${channel.name}"`
                }));

            } else if (parsed.type === 'delete_channel') {
                const serverId = parsed.serverId;
                const channelId = parsed.channelId;
                const server = servers[serverId];
                
                if (!server) {
                    ws.send(JSON.stringify({ type: 'error', text: 'Сервер не найден!' }));
                    return;
                }
                
                if (server.creator !== 'system' && server.creator !== parsed.username) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        text: 'Только создатель сервера может удалять каналы!'
                    }));
                    return;
                }
                
                const channelIndex = server.channels.findIndex(ch => ch.id === channelId);
                if (channelIndex === -1) {
                    ws.send(JSON.stringify({ type: 'error', text: 'Канал не найден!' }));
                    return;
                }
                
                const channelName = server.channels[channelIndex].name;
                server.channels.splice(channelIndex, 1);
                delete server.messages[channelId];
                
                clients.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        const data = getClientData(client);
                        if (data.serverId === serverId && data.channelId === channelId) {
                            if (server.channels.length > 0) {
                                data.channelId = server.channels[0].id;
                                sendChannelHistory(client, serverId, server.channels[0].id);
                            }
                        }
                    }
                });
                
                broadcastServersList();
                
                ws.send(JSON.stringify({
                    type: 'system',
                    text: `🗑️ Канал "${channelName}" удалён`
                }));

            } else if (parsed.type === 'update_profile') {
                const username = parsed.username;
                const profile = getUserProfile(username);
                
                if (parsed.displayName) profile.displayName = parsed.displayName;
                if (parsed.status) profile.status = parsed.status;
                if (parsed.avatar) profile.avatar = parsed.avatar;
                if (parsed.theme) profile.theme = parsed.theme;
                if (parsed.notifications !== undefined) profile.notifications = parsed.notifications;
                if (parsed.showActivity !== undefined) profile.showActivity = parsed.showActivity;
                if (parsed.language) profile.language = parsed.language;
                if (parsed.about !== undefined) profile.about = parsed.about;
                if (parsed.customStatus !== undefined) profile.customStatus = parsed.customStatus;
                
                console.log(`📝 Обновлён профиль пользователя: ${username}`);
                
                ws.send(JSON.stringify({
                    type: 'system',
                    text: `✅ Профиль обновлён!`
                }));
            }
        } catch (error) {
            console.error('❌ Ошибка обработки сообщения:', error);
            ws.send(JSON.stringify({
                type: 'error',
                text: 'Ошибка на сервере: ' + error.message
            }));
        }
    });

    ws.on('close', () => {
        console.log('🔴 Пользователь отключился');
        clients.delete(ws);
        clientData.delete(ws);
    });

    ws.on('error', (error) => {
        console.error('❌ WebSocket ошибка:', error);
        clients.delete(ws);
        clientData.delete(ws);
    });
});

function getUserProfile(username) {
    if (!userProfiles[username]) {
        userProfiles[username] = {
            username: username,
            displayName: username,
            status: 'online',
            avatar: null,
            theme: 'dark',
            notifications: true,
            showActivity: true,
            language: 'ru',
            about: '',
            customStatus: ''
        };
    }
    return userProfiles[username];
}

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
    console.log(`📡 WebSocket сервер активен на ws://localhost:${PORT}`);
    console.log(`📁 Доступные серверы: ${Object.keys(servers).join(', ')}`);
});