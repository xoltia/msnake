const http = require('http');
const WebSocket = require('ws');
const shortid = require('shortid');
const url = require('url');
const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, 'index.html');
const html = process.env.CACHE_HTML ? fs.readFileSync(htmlPath) : null;
const server = http.createServer((req, res) => {
    const query = url.parse(req.url, true).query;
    if (!query.room) {
        res.writeHead(302, {
            Location: `/?room=${shortid.generate()}${Object.entries(query).map(([k, v]) => `&${k}=${v}`).join('')}`,
        });
        return res.end();
    }
    res.setHeader('Content-Type', 'text/html');
    if (html) {
        res.write(html);
        return res.end();
    }
    
    fs.readFile(htmlPath, (err, data) => {
        if (err) console.log(err);
        res.write(data);
        res.end();
    });
});
const wss = new WebSocket.Server({ noServer: true });

const rooms = {};
const defaultTickRate = 10;
const defaultSize = 50;
const defaultAppleCount = 1;
const directionVelocities = {
    'left':  [-1, 0],
    'right': [1, 0],
    'up':    [0, -1],
    'down':  [0, 1]
}

function broadcastState(room) {
    for (let player of room.players) {
        player.ws.send(JSON.stringify({
            event: 'update_board',
            players: room.players
                        .filter(p => !p.isDead)
                        .map(p => p.positions),
            apples: room.apples
        }));
    }
}

function posIsFree(room, x, y) {
    for (let player of room.players) {
        for (let cell of player.positions) {
            if (cell[0] === x && cell[1] === y)
                return false;
        }
    }
    return true;
}

function randomFreePosition(room) {
    let pos;
    do {
        pos = [
            Math.floor(Math.random() * room.size),
            Math.floor(Math.random() * room.size)
        ]
    } while (!posIsFree(room, ...pos));
    return pos;
}

function tickRoom(room) {
    for (let player of room.players) {
        if (player.isDead) continue;
        const posUpdate = directionVelocities[player.direction];
        const newHead = player.positions[0].map((v, i) => v + posUpdate[i]);
        const oldPositions = [...player.positions];

        if (player.growNextTick) {
            player.positions.push([...player.positions[player.positions.length - 1]]);
            player.growNextTick = false;
        }

        for (let i = 1; i < player.positions.length; i++) {
            player.positions[i] = [...oldPositions[i - 1]];
        }

        player.positions.shift();
        player.positions.unshift(newHead);
    }

    for (let player of room.players) {
        if (player.isDead) continue;
        const head = player.positions[0];
        if (head[0] < 0 || head [1] < 0 || head[0] >= room.size || head[1] >= room.size) {
            player.isDead = true;
            continue;
        }
        for (let player2 of room.players) {
            if (player2.isDead) continue;
            const head2 = player2.positions[0];
            if (player !== player2 && head[0] === head2[0] && head[1] === head2[1]) {
                if (player.positions.length > player2.positions.length) {
                    player.isDead = true;
                } else {
                    player2.isDead = true;
                }
                continue;
            }
            for (let cell of player2.positions) {
                if (cell === head) continue;
                if (head[0] === cell[0] && head[1] === cell[1]) {
                    player.isDead = true;
                }
            }
        }

        for (let [i, apple] of room.apples.entries()) {
            if (apple[0] === head[0] && apple[1] === head[1]) {
                player.growNextTick = true;
                room.apples[i] = randomFreePosition(room);
            }
        }
    }

    if (room.players.filter(p => !p.isDead).length === 0) {
        // TODO: function for resetting/starting room
        clearInterval(room.interval);
        room.isStarted = false;
        for (let [i, player] of room.players.entries()) {
            player.isDead = false;
            player.positions = [
                i === 0 ? [1, 1] :
                i === 1 ? [room.size - 2, 1] :
                i === 2 ? [1, room.size - 2] :
                i === 3 ? [room.size - 2, room.size - 2] :
                undefined
            ];
            player.direction = i % 2 === 0 ? 'right' : 'left'
            player.growNextTick = false;
        }
    }
    broadcastState(room);
}

wss.on('connection', (ws, req, room, player) => {
    ws.send(JSON.stringify({ event: 'set_board', size: room.size }));
    broadcastState(room);
    ws.on('message', (data) => {
        const message = JSON.parse(data);
        if (!message.cmd)
            return;
        if (message.cmd === 'start' && player.isHost && !room.isStarted) {
            room.isStarted = true;
            room.interval = setInterval(tickRoom.bind(null, room), 1000 / room.tickRate);
        } else if (message.cmd === 'set_direction' && room.isStarted) {
            if (!message.dir)
                return;
            player.direction = message.dir;
        } else if (message.cmd === 'update_room' && !room.isStarted && player.isHost) {
            if (message.appleCount && !isNaN(message.appleCount)) {
                room.apples = [];
                for (let i = 0; i < Number(message.appleCount); i++) {
                    room.apples.push([
                        Math.floor(Math.random() * room.size),
                        Math.floor(Math.random() * room.size)
                    ]);
                }
            }

            if (message.size && !isNaN(message.size)) {
                room.size = Number(message.size);
                for (let player of room.players) {
                    player.ws.send(JSON.stringify({ event: 'set_board', size: room.size }));
                }
            }

            if (message.tickRate && !isNaN(message.tickRate)) {
                room.tickRate = Number(message.tickRate);
            }
        };
    });

    ws.on('close', () => {
        room.players = room.players.filter(p => p !== player);
        if (room.players.length < 1) {
            clearInterval(room.interval);
            delete rooms[room.id];
            return;
        }
        room.players[0].isHost = true;
    });
});

server.on('upgrade', (request, socket, head) => {
    const query = url.parse(request.url, true).query;
    const roomId = query.room;
    if (!roomId) return;
    const roomSize = query.size && !isNaN(query.size) ? Number(query.size) : defaultSize;
    const tickRate = query.tick_rate && !isNaN(query.tick_rate) ? Number(query.tick_rate) : defaultTickRate;
    const appleCount = query.apples && !isNaN(query.apples) ? Number(query.apples) : defaultAppleCount;

    if (!rooms[roomId]) {
        rooms[roomId] = {
            size: roomSize,
            isStarted: false,
            players: [],
            id: roomId,
            apples: [],
            tickRate
        };
        for (let i = 0; i < appleCount; i++) {
            rooms[roomId].apples.push([
                Math.floor(Math.random() * rooms[roomId].size),
                Math.floor(Math.random() * rooms[roomId].size)
            ]);
        }
    }
    const room = rooms[roomId];


    if (room.isStarted || room.players.length === 4) {
        return socket.end('HTTP/1.1 423 Locked\r\n\r\nThis game has started or has the maximum allowed of players.\r\n\r\n\r\n');
    }

    const player = {
        direction: room.players.length % 2 === 0 ? 'right' : 'left',
        isHost: room.players.length === 0,
        positions: [
            room.players.length === 0 ? [1, 1] :
            room.players.length === 1 ? [roomSize - 2, 1] :
            room.players.length === 2 ? [1, roomSize - 2] :
            room.players.length === 3 ? [roomSize - 2, roomSize - 2] :
            undefined
        ],
        isDead: false,
        growNextTick: false,
    };
    room.players.push(player);

    wss.handleUpgrade(request, socket, head, (ws) => {
        player.ws = ws;
        wss.emit('connection', ws, request, room, player);
    });
});

server.listen(process.env.PORT);