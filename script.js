const wsURL = "wss://peterzhong.ca:2096";
// let ws = null;
let pingInterval = null;
let pongTimeout = null;
// const ws = new WebSocket(wsURL);
const cookie = encodeURIComponent(document.cookie);
const ws = new WebSocket(`wss://peterzhong.ca:2096?cookie=${cookie}`);
const messagesDiv = document.getElementById("messages");
let countdownInterval = null; // Store interval ID for countdown
let userID = getCookie("userID");


ws.onopen = () => {
    console.log("Connected to WebSocket server.");
    startPingPong();
};



ws.onclose = () => {
    console.log("WebSocket connection closed.");
    clearInterval(pingInterval); // Clear the ping interval when connection is closed
    clearTimeout(pongTimeout); // Clear the timeout when connection is closed
};

ws.onerror = (error) => {
    console.error("WebSocket error:", error);
    ws.close();
};

// Handle WebSocket messages
ws.onmessage = (event) => {
    let msg = JSON.parse(event.data);

    console.log("Received:", msg);

    // If userID is received from server, store and display it
    if (msg.system && msg.userID) {
        userID = msg.userID;
        setCookie("userID", userID, 30);
        document.getElementById("user-id").textContent = "Your User ID: " + userID;
    }

    if (msg.type === "pong") {
        console.log("Pong received!");
        clearTimeout(pongTimeout); // Reset pong timeout
    }

    // Log received enabled fields when update_choices message is received
    if (msg.type === "update_choices" && msg.choices) {
        console.log("Received enabled choices:", msg.choices);
        updateButtons(msg.choices);
    }

    // Handle voting alert and start countdown
    if (msg.type === "alert" && msg.remainingTime) {
        startCountdown(msg.remainingTime);
    }

    if (msg.type === "state_update" && msg.remainingTime) {
        startCountdown(msg.remainingTime);
    }

    if (msg.type === "send_results") {
        updateResults(msg.result);
    }


};

function startPingPong() {
    clearInterval(pingInterval);
    pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
            console.log("Ping sent");

            pongTimeout = setTimeout(() => {
                console.warn("Pong not received, closing WebSocket...");
                ws.close(); // Force reconnect if no pong is received
            }, 5000); // 5 seconds timeout
        }
    }, 30000); // Send ping every 30 seconds
}

function updateResults(results) {
    const resultsText = document.getElementById("countdown");

    if (results.length === 0) {
        resultsText.textContent = "No results yet.";
        return;
    }

    // Convert results to a single string
    const resultString = results.map(result => `${result.choice}: ${result.count} votes`).join(" | ");

    resultsText.textContent = resultString;
}

function startCountdown(seconds) {
    const countdownElement = document.getElementById("countdown");
    countdownElement.textContent = `Voting ends in: ${seconds} seconds`;

    clearInterval(countdownInterval); // Clear any existing countdown
    countdownInterval = setInterval(() => {
        seconds--;
        if (seconds > 0) {
            countdownElement.textContent = `Voting ends in: ${seconds} seconds`;
        } else {
            clearInterval(countdownInterval);
            console.log('voting has ended');
            // countdownElement.textContent = "Voting has ended.";
            document.getElementById("buttons-container").innerHTML = ""; // Remove buttons
        }
    }, 1000);
}




function updateButtons(choices) {
    const container = document.getElementById("buttons-container");
    const countdownElement = document.getElementById("countdown");
    container.innerHTML = ""; // Clear existing buttons
    countdownElement.innerHTML = "";

    choices.forEach(choice => {
        if (choice.enabled && choice.label) { // Only create buttons for enabled choices with labels
            const button = document.createElement("button");
            button.textContent = choice.label;
            button.classList.add("choice-btn");

            button.onclick = () => sendChoice(choice.label);

            container.appendChild(button);
        }
    });
}


function sendChoice(choiceLabel) {
    const container = document.getElementById("buttons-container");
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "vote", choice: choiceLabel }));
        console.log(`Sent choice: ${choiceLabel}`);
        container.innerHTML = "Thank you for voting!"; // Clear existing buttons
    } else {
        console.error("WebSocket is not open.");
    }
}


// Cookie Functions
function setCookie(name, value, days) {
    let expires = "";
    if (days) {
        let date = new Date();
        date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
        expires = "; expires=" + date.toUTCString();
    }
    document.cookie = name + "=" + value + "; path=/" + expires;
}

function getCookie(name) {//name is just 'userID', the field of cookie storing the userID
    console.log("document.cookie:", document.cookie); // Log the cookies string

    // let match = document.cookie.match(new RegExp("(^| )" + name + "=([^;]+)"));

    // console.log("Regex match result for", name, ":", match); // Log the match result

    // console.log("match [2] is :",match[2])

    getUserID();
    let cookies = document.cookie.split("; ").find(row => row.startsWith(name));
    return cookies ? cookies.split("=")[1] : null

    return match ? match[2] : null;
}

function getUserID() {
    let cookies = document.cookie.split("; ").find(row => row.startsWith("userID="));
    console.log("new approach: ", cookies ? cookies.split("=")[1] : null);
}