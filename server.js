const http = require('http');
const WebSocket = require('ws');
const shortid = require('shortid');
const url = require('url');
const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, 'index.html');
const html = process.env.CACHE_HTML ? fs.readFileSync(htmlPath) : null;
const server = http.createServer((req, res) => {
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
            apple: room.apple
        }));
    }
}

function moveApple(room) {
    room.apple = [Math.floor(Math.random() * room.size), Math.floor(Math.random() * room.size)];
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
            for (let cell of player2.positions) {
                if (cell === head) continue;
                if (head[0] === cell[0] && head[1] === cell[1]) {
                    player.isDead = true;
                }
            }
        }

        if (head[0] === room.apple[0] && head[1] === room.apple[1]) {
            player.growNextTick = true;
            moveApple(room);
        }
    }

    if (room.players.filter(p => !p.isDead).length === 0) {
        // TODO: function for resetting/starting room
        clearInterval(room.interval);
        room.isStarted = false;
        let i = 0;
        for (let player of room.players) {
            player.isDead = false;
            player.positions = [
                i === 0 ? [1, 1] :
                i === 1 ? [defaultSize - 1, 1] :
                i === 2 ? [1, defaultSize - 1] :
                i === 3 ? [defaultSize - 1, defaultSize - 1] :
                undefined
            ];
            i++;
            player.direction = i % 2 === 0 ? 'left' : 'right'
            player.growNextTick = false;
        }
    }
    broadcastState(room);
}

wss.on('connection', (ws, req, room, player) => {
    ws.on('message', (data) => {
        const message = JSON.parse(data);
        if (!message.cmd)
            return;
        if (message.cmd === 'start' && player.isHost && !room.isStarted) {
            room.isStarted = true;
            moveApple(room);
            room.interval = setInterval(tickRoom.bind(null, room), 1000 / defaultTickRate);
        } else if (message.cmd === 'set_direction' && room.isStarted) {
            if (!message.dir)
                return;
            player.direction = message.dir;
        }
    });
});

server.on('upgrade', (request, socket, head) => {
    const roomId = url.parse(request.url, true).query.room || shortid.generate();
    
    if (!rooms[roomId])
        rooms[roomId] = { size: defaultSize, isStarted: false, players: [], id: roomId };
    const room = rooms[roomId];

    if (room.isStarted || room.players.length === 4) {
        return socket.end('HTTP/1.1 423 Locked\r\n\r\nThis game has started or has the maximum allowed of players.\r\n\r\n\r\n');
    }

    const player = {
        direction: room.players.length % 2 === 0 ? 'right' : 'left',
        isHost: room.players.length === 0,
        positions: [
            room.players.length === 0 ? [1, 1] :
            room.players.length === 1 ? [defaultSize - 1, 1] :
            room.players.length === 2 ? [1, defaultSize - 1] :
            room.players.length === 3 ? [defaultSize - 1, defaultSize - 1] :
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