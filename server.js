const fs = require("fs");
const https = require("https");
const WebSocket = require("ws");
const mysql = require("mysql");
const { parse } = require("cookie");
require("dotenv").config();

// Load SSL Certificate
const server = https.createServer({
    cert: fs.readFileSync("C:/Users/Peter/cert.pem"),
    key: fs.readFileSync("C:/Users/Peter/key.pem")
});

let serverState = 'idle';
let votingStartTime = null; // Store voting start timestamp
let lastResult = null;
const VOTING_DURATION = 30000; // 30 seconds


// MySQL Connection
// const db = mysql.createConnection({
//     host: "localhost",
//     user: "root",
//     password: "",
//     database: "voting_db"
// });

const db = mysql.createPool({
    connectionLimit: 10, // Limit number of connections in the pool
    host: "localhost",
    user: "root",
    password: "",
    database: "voting_db"
});

// db.connect(err => {
//     if (err) throw err;
//     console.log("MySQL Connected!");
// });

function handleDisconnect() {
    db.getConnection((err, connection) => {
        if (err) {
            console.error("Database connection failed:", err);
            setTimeout(handleDisconnect, 2000); // Try reconnecting after 2 seconds
        } else {
            console.log("MySQL Connected!");
            connection.release(); // Release connection back to the pool
        }
    });
}

handleDisconnect();

// WebSocket Server using HTTPS
const wss = new WebSocket.Server({ server });

// const wss = new WebSocket.Server({
//     server, // Refer to your HTTPS server
//     handleProtocols: (protocols, request) => {
//         // Allow only connections from your frontend domain
//         const origin = request.headers.origin;
//         const allowedOrigin = "https://your-frontend-url.com"; // Replace with your frontend URL

//         // If the origin is allowed, return true, else return false
//         return origin === allowedOrigin ? true : false;
//     },
//     verifyClient: (info, done) => {
//         const origin = info.origin;
//         const allowedOrigin = "https://your-frontend-url.com"; // Your frontend URL

//         // Allow connection only if the origin matches your frontend
//         if (origin === allowedOrigin) {
//             done(true); // Allow connection
//         } else {
//             done(false, 403, "Forbidden");
//         }
//     }
// });

const submittedUsers = new Set();
const votedUsers = new Set();

wss.on("connection", (ws, req) => {
    const ip = req.socket.remoteAddress;
    console.log(`User connected from IP: ${ip}`);
    const url = new URL(req.url, `https://${req.headers.host}`);
    var cookie = url.searchParams.get("cookie");
    

    const name = "userID";  // The name of the cookie you're looking for
    if (cookie){

        cookie = cookie.split("; ").find(row => row.startsWith(name));
        cookie = cookie ? cookie.split("=")[1] : null;
    }
    // console.log(req);

    let userID = ""
    
    
    if (cookie != null && cookie != ""){ //cookie exists <- this refers to admin page only
        console.log("cookie isn't null, it's ", cookie)
        console.log(cookie);
        userID = cookie;
    } else {
        userID = getUserID(req);
    }
    // console.log("cookie is null");
    ws.send(JSON.stringify({ system: true, userID }));

    onClientConnected(ws, userID);
    if (!votedUsers.has(userID)){

        sendChoicesToUser(ws);
    } else {
        // todo: user has voted, vote ongoing
        if (serverState == "result"){
            ws.send(JSON.stringify({type: "send_results", result: lastResult}))
        }
    }

    ws.on("message", (data) => handleMessage(ws, data, userID));
    ws.on("close", () => console.log("Client disconnected"));
});

function getUserID(req) {
    let cookies = parse(req.headers.cookie || "");
    let userID = cookies.userID;

    if (!userID) {
        userID = Math.floor(Math.random() * 1000000);
        console.log(`New userID generated: ${userID}`);
    } else {
        console.log(`User with ID ${userID} connected`);
    }

    return userID;
}

function handleMessage(ws, data, userID) {
    if (submittedUsers.has(userID)) return;

    let msg;
    try {
        msg = JSON.parse(data);
    } catch (err) {
        console.error("Error parsing message:", err);
        return;
    }

    switch (msg.type) {
        case 'clear_database':
            clearDatabase();
            break;
        case 'update_choices':
            updateChoices(msg.choices);
            break;
        case 'alert': //alert used to be the vote call
            clearVotes();
            votedUsers.clear();
            sendAlert(msg.message);
            break;

        case 'vote':
            userVote(msg.choice, userID);
            break;

        case 'send_results':
            showResults();
            break;

        case 'ping':
            ws.send(JSON.stringify({ type: 'pong' })); // Send back pong
            break

        case 'stop_vote':
            ws.send(JSON.stringify({ type: 'stop_vote' }));
            break

        default: // this is the admin page data insert option
            // saveAndBroadcastMessage(msg);
            break;
    }
}

function userVote(choice, id){
    //id in votedUsers,
    //id not in votedUsers
    // ->add choice to votes table if id not in voted users
    // -> add id to voted users table 
    const sql = `
        INSERT INTO votes (user_id, choice)
        SELECT ?, ? 
        WHERE NOT EXISTS (
            SELECT 1 FROM voted_user WHERE user_id = ?
        )
    `;

    if (votedUsers.has(id)){
        return;
    }

    db.query(sql, [id, choice, id], (err, results) => {
        if (err) {
            console.error("Error inserting vote:", err);
            return;
        }

        // Check if the vote was inserted (affectedRows > 0 means vote was allowed)
        if (results.affectedRows > 0) {
            console.log(`User ${id} voted for ${choice}`);

            // Now insert into voted_users table
            db.query("INSERT INTO voted_user (user_id) VALUES (?)", [id], (err) => {
                if (err) {
                    console.error("Error adding user to voted_users:", err);
                    return;
                }
                console.log(`User ${id} added to voted_users table.`);
            });
        } else {
            console.log(`User ${id} has already voted. Ignoring vote.`);
        }
    });

    votedUsers.add(id)
}

function clearVotes() {
    console.log("Received 'clear_database' message");
    db.query("DELETE FROM votes", (err) => {
        if (err) {
            console.error("Error clearing votes table:", err);
            return;
        }
        console.log("Votes table cleared.");
    });

    // Clear the voted_users table independently
    db.query("DELETE FROM voted_user", (err) => {
        if (err) {
            console.error("Error clearing voted_users table:", err);
            return;
        }
        console.log("voted_users table cleared.");

        // Optionally, clear the votedUsers set
        votedUsers.clear();
        console.log("votedUsers set cleared.");
    });
}

function updateChoices(choices) {
    console.log("Received 'update_choices' message with choices:", choices);
    serverState = "idle";
    broadcast({ type: 'state_update', state: "idle" });
    console.log("Server state changed to 'idle'");
    
    // Clear existing choices
    db.query("DELETE FROM choices", (err) => {
        if (err) throw err;
        console.log("Choices table cleared");
    
        const values = choices.map(choice => [choice.label, choice.enabled]);
        
        if (values.length > 0) {
            db.query("INSERT INTO choices (label, enabled) VALUES ?", [values], (err) => {
                if (err) throw err;
                console.log("Choices inserted into database");
            });
        }
        
        broadcast({ type: 'update_choices', choices });
    });
}

function sendAlert(message) {
    serverState = "voting";
    // broadcast({ type: 'alert', message });
    console.log("Server state changed to 'voting'");

    votingStartTime = Date.now(); // Record voting start time
    broadcast({ type: 'alert', message, state: "voting", remainingTime: VOTING_DURATION / 1000 });

    // Start a 30-second timer before switching to 'result' state
    setTimeout(() => {
        serverState = "result";
        votingStartTime = null; // Clear the timestamp
        broadcast({ type: 'state_update', state: "result" });
        console.log("Server state changed to 'result'");
        showResults();

    }, VOTING_DURATION); // 30 seconds
}

function onClientConnected(client, id) {
    console.log("New client connected");


    // If voting is active, send remaining time
    if (serverState === "voting" && votingStartTime) {

        if (!votedUsers.has(id)){

            let elapsedTime = Date.now() - votingStartTime;
            let remainingTime = Math.max(0, (VOTING_DURATION - elapsedTime) / 1000); // Convert ms to seconds
            
            client.send(JSON.stringify({
                type: "state_update",
                state: "voting",
                remainingTime: remainingTime
            }));
            
            console.log(`Sent remaining time: ${remainingTime} seconds`);
        } else {
            //todo: is in voted user, what happens?
        }
    } else {
        // Send current state to the new client
        client.send(JSON.stringify({ type: "state_update", state: serverState }));
    }
}

function showResults(){
    console.log('result state')

    const sql = `
        SELECT choice, COUNT(*) as count 
        FROM votes 
        GROUP BY choice
        ORDER BY count DESC
    `;

    db.query(sql, (err, results) => {
        if (err) {
            console.error("Error fetching results:", err);
            return;
        }

        console.log("Voting Results:");
        results.forEach(row => {
            console.log(`Choice: ${row.choice}, Votes: ${row.count}`);
        });
        lastResult = results;
        broadcast({type: "send_results", result : results});
    });
}

function saveAndBroadcastMessage(msg) {
    let sql = "INSERT INTO messages (user, message) VALUES (?, ?)";
    db.query(sql, [msg.user, msg.message], (err) => {
        if (err) throw err;
        broadcast({ user: msg.user, message: msg.message, timestamp: new Date() });
    });
}

function sendChoicesToUser(ws) {
    db.query("SELECT label, enabled FROM choices", (err, results) => {
        if (err) throw err;
        ws.send(JSON.stringify({ type: 'update_choices', choices: results }));
    });
}

function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

server.listen(2096, () => {
    console.log("Secure WebSocket server running on wss://peterzhong.ca:2096");
});
