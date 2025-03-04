const fs = require("fs");
const https = require("https");
const WebSocket = require("ws");
const mysql = require("mysql");
const { parse } = require("cookie");
require("dotenv").config();
const SECRET_ROLE = process.env.SECRET_ROLE;

// todo: add timer for non super user, and add super user check

// Load SSL Certificate
const server = https.createServer({
    cert: fs.readFileSync("C:/Users/Peter/cert.pem"),
    key: fs.readFileSync("C:/Users/Peter/key.pem")
});

let serverState = 'idle';
let votingStartTime = null; // Store voting start timestamp
let lastResult = null;
var VOTING_DURATION = 31000; // 31 seconds, users get 1 less second
let votingTimeout = null; // Global variable to store setTimeout ID



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

const submittedUsers = new Set();
const votedUsers = new Set();

var superUser = null;
var userLoginTime = null;
var isSuper = false;

wss.on("connection", (ws, req) => {
    const ip = req.socket.remoteAddress;
    console.log(`User connected from IP: ${ip}`);
    const url = new URL(req.url, `https://${req.headers.host}`);
    var cookie = url.searchParams.get("cookie");
    var role = url.searchParams.get("role");

    //todo: ??
    if (role === "admin") {
        const currentTime = Date.now();

        console.log("is admin")
        if (!isSuper && (userLoginTime == null || currentTime - userLoginTime >= 60000)) { // check !isSuper and make sure either userLoginTime is null or time has passed
            // If a super user exists and their session has expired, close the old connection
            if (superUser) {
                superUser.terminate();
                console.log("superUser.termiante() called from admin tree");
            }

            // Assign new super user
            superUser = ws;
            userLoginTime = currentTime;
            // isSuper = true;
            console.log("New super user session started.");
        } else {
            console.log("due to constarint terminating conection");
            ws.send(JSON.stringify({ type: "ack", message: "another user is using the server, try again later" }))
            setTimeout(() =>{
                ws.terminate();
                return;
            }, 100)
        }
    }

    //todo: check if role guess is wrong, if so their cookie is added to balcklist for 30 seconds
    if (role == SECRET_ROLE){ // kill current superUser session; no interrupt allowed 
        ws.send(JSON.stringify({ type: "ack", message: "hello super user" }))
        if (superUser) {
            superUser.terminate(); // Forcefully close the last admin's connection
            console.log("superUser.terminate() called from secret role tree");
        }
    
        // Add a timeout to ensure the superUser connection cleanup happens first
        setTimeout(() => {
            superUser = ws; // Reassign superUser after cleanup
            isSuper = true; // Set the new superUser flag
            console.log("Super user session started.");
        }, 100); // 100 ms timeout
    }

    if (role != SECRET_ROLE && role != "admin" && role != null){//
        ws.terminate();
        console.log("wrong guess");
    }

    if (role == null){
        // console.log(cookie);
        // add to list of voters
    }

    // console.log('visitor role is: ', role);
    

    const name = "userID";  // The name of the cookie you're looking for
    if (cookie){

        cookie = cookie.split("; ").find(row => row.startsWith(name));
        cookie = cookie ? cookie.split("=")[1] : null;
    }
    // console.log(req);

    let userID = ""
    
    
    if (cookie != null && cookie != ""){ //cookie exists <- this refers to admin page only
        console.log("cookie isn't null, it's ", cookie)
        //console.log(cookie);
        userID = cookie;
    } else {
        userID = getUserID(req);
    }

    //at this point userID is certainly assigned
    
    // console.log("cookie is null");
    ws.send(JSON.stringify({ system: true, userID }));
    userID = String(userID) //important, getUserId returns a number

    onClientConnected(ws, userID);
    

    ws.on("message", (data) => handleMessage(ws, data, userID));
    ws.on("close", () => {
        console.log("Client disconnected");
    
        if (ws === superUser) {
            isSuper = false; // always reset
            userLoginTime = null;
            console.log("admin disconnected.");
        }
    });
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
            if (msg.time == ''){
                console.log("time should be infinite")
            } else {

                console.log("time should be ",msg.time);
            }
            votedUsers.clear();
            sendAlert(msg.message, msg.time);
            break;

        case 'vote':
            userVote(msg.choice, userID);
            break;

        case 'send_results': // this option doesn't happen
            console.log("voting time out is ", votingTimeout);
            // if (votingTimeout) {
            //     clearTimeout(votingTimeout);
            //     votingTimeout = null; // Reset the variable
            //     console.log("Voting timeout canceled.");
            // }
            showResults();
            break;

        case 'ping':
            ws.send(JSON.stringify({ type: 'pong' })); // Send back pong
            break

        case 'stop_vote':
            console.log("sending stop_vote")
            if (votingTimeout) {
                clearTimeout(votingTimeout);
                votingTimeout = null; // Reset the variable
                console.log("Voting timeout canceled.");
            }
            stopVote();
            // ws.send(JSON.stringify({ type: 'stop_vote' }));
            break

        default: // this is the admin page data insert option
            // saveAndBroadcastMessage(msg);
            break;
    }
}

function stopVote(){
    broadcast({ type: 'stop_vote' });
    result_body();
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
            console.log(`User ${id}al voted for ${choice}`);

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

function sendAlert(message, time) {
    serverState = "voting";
    // broadcast({ type: 'alert', message });
    console.log("Server state changed to 'voting'");

    votingStartTime = Date.now(); // Record voting start time
    VOTING_DURATION = time;
    if (time == ''){
        broadcast({ type: 'alert', message, state: "voting" , remainingTime : VOTING_DURATION}); // users need a '' remaining time check


    } else{
        VOTING_DURATION = time * 1000;
        broadcast({ type: 'alert', message, state: "voting", remainingTime: VOTING_DURATION / 1000 - 1 }); // USERS ALWAYS FINISH BEFORE SERVER, FOR TIMING PURPOSES
    
        // Start a 30-second timer before switching to 'result' state
        votingTimeout = setTimeout(() => {
            result_body();
    
        }, VOTING_DURATION); // 30 seconds
    }
    
}

function result_body(){
    serverState = "result";
    votingStartTime = null; // Clear the timestamp
    broadcast({ type: 'state_update', state: "result" });
    console.log("Server state changed to 'result'");
    showResults();
    votingTimeout = null;
}

function onClientConnected(client, id) {
    console.log("New client connected");


    // If voting is active, send remaining time
    if (serverState === "voting" && votingStartTime) {

        if (!votedUsers.has(id)){ // user not voted, jsut connected during vote
            console.log("votedUsers are :", votedUsers)
            let elapsedTime = Date.now() - votingStartTime;

            //done: if user conects admist endlessvote,send ''
            let remainingTime = null;
            
            if (VOTING_DURATION != ''){

                remainingTime = Math.max(0, (VOTING_DURATION - elapsedTime) / 1000); // Convert ms to seconds 
            } else {
                remainingTime = '';
            }

            
            client.send(JSON.stringify({
                type: "state_update",
                state: "voting",
                remainingTime: remainingTime
            }));
            
            console.log("user not voted, sending over choices") 
            sendChoicesToUser(client);
            console.log(`Sent remaining time: ${remainingTime} seconds`);
        } else {
            console.log("from else, votedUsers are :", votedUsers)
            client.send(JSON.stringify({
                type: "state_update",
                state: "voting",
                voted : true
            }));
        }
    } 
    if (serverState == "result"){ // result or idle states
        // Send current state to the new client
        client.send(JSON.stringify({ type: "state_update", state: serverState }));
        client.send(JSON.stringify({type: "send_results", result: lastResult}))
        sendChoicesToUser(client);
    } 
    if (serverState == "idle"){
         //idle state
        client.send(JSON.stringify({ type: "state_update", state: serverState }));
        sendChoicesToUser(client);
    }
}

function showResults(){
    console.log('result state')

    const sql = `
        SELECT choice, COUNT(*) as count 
        FROM votes 
        GROUP BY choice
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
