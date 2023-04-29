/**
 * Copyright 2019 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

"use strict";

const functions = require("firebase-functions");
const {smarthome} = require("actions-on-google");
const {google} = require("googleapis");
const util = require("util");
const admin = require("firebase-admin");
const https = require("follow-redirects").https;

// Initialize Firebase
admin.initializeApp();
const firebaseRef = admin.database().ref("/");
// Initialize Homegraph
const auth = new google.auth.GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/homegraph"],
});
const homegraph = google.homegraph({
  version: "v1",
  auth: auth,
});
// Hardcoded user ID
const USER_ID = "123";

exports.login = functions.https.onRequest((request, response) => {
  if (request.method === "GET") {
    functions.logger.log("Requesting login page");
    response.send(`
    <html>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <body>
        <form action="/login" method="post">
          <input type="hidden"
            name="responseurl" value="${request.query.responseurl}" />
          <button type="submit" style="font-size:14pt">
            Link this service to Google
          </button>
        </form>
      </body>
    </html>
  `);
  } else if (request.method === "POST") {
    // Here, you should validate the user account.
    // In this sample, we do not do that.
    const responseurl = decodeURIComponent(request.body.responseurl);
    functions.logger.log(`Redirect to ${responseurl}`);
    return response.redirect(responseurl);
  } else {
    // Unsupported method
    response.send(405, "Method Not Allowed");
  }
});

exports.fakeauth = functions.https.onRequest((request, response) => {
  const responseurl = util.format(
      "%s?code=%s&state=%s",
      decodeURIComponent(request.query.redirect_uri),
      "xxxxxx",
      request.query.state,
  );
  functions.logger.log(`Set redirect as ${responseurl}`);
  return response.redirect(
      `/login?responseurl=${encodeURIComponent(responseurl)}`,
  );
});

exports.faketoken = functions.https.onRequest((request, response) => {
  const grantType = request.query.grant_type ?
    request.query.grant_type :
    request.body.grant_type;
  const secondsInDay = 86400; // 60 * 60 * 24
  const HTTP_STATUS_OK = 200;
  functions.logger.log(`Grant type ${grantType}`);

  let obj;
  if (grantType === "authorization_code") {
    obj = {
      token_type: "bearer",
      access_token: "123access",
      refresh_token: "123refresh",
      expires_in: secondsInDay,
    };
  } else if (grantType === "refresh_token") {
    obj = {
      token_type: "bearer",
      access_token: "123access",
      expires_in: secondsInDay,
    };
  }
  response.status(HTTP_STATUS_OK).json(obj);
});

const app = smarthome();

app.onSync((body) => {
  return {
    requestId: body.requestId,
    payload: {
      agentUserId: USER_ID,
      devices: [
        // {
        //   id: "washer",
        //   type: "action.devices.types.WASHER",
        //   traits: [
        //     "action.devices.traits.OnOff",
        //     "action.devices.traits.StartStop",
        //     "action.devices.traits.RunCycle",
        //   ],
        //   name: {
        //     defaultNames: ["My Washer"],
        //     name: "Washer",
        //     nicknames: ["Washer"],
        //   },
        //   deviceInfo: {
        //     manufacturer: "Acme Co",
        //     model: "acme-washer",
        //     hwVersion: "1.0",
        //     swVersion: "1.0.1",
        //   },
        //   willReportState: true,
        //   attributes: {
        //     pausable: true,
        //   },
        //   // TODO: Add otherDeviceIds for local execution
        // },
        {
          id: "lock",
          type: "action.devices.types.LOCK",
          traits: ["action.devices.traits.LockUnlock"],
          name: {
            defaultNames: ["My Door Lock"],
            name: "Door Lock",
            nicknames: ["Door Lock"],
          },
          deviceInfo: {
            manufacturer: "Yale",
            model: "yale-lock",
            hwVersion: "1.0",
            swVersion: "1.0.1",
          },
          willReportState: false,
        },
      ],
    },
  };
});

const queryFirebase = async (deviceId) => {
  const snapshot = await firebaseRef.child(deviceId).once("value");
  const snapshotVal = snapshot.val();
  return {
    // on: snapshotVal.OnOff.on,
    // isPaused: snapshotVal.StartStop.isPaused,
    // isRunning: snapshotVal.StartStop.isRunning,
    isLocked: snapshotVal.LockUnlock.isLocked,
    isJammed: snapshotVal.LockUnlock.isJammed,
    online: snapshotVal.LockUnlock.online,
    status: snapshotVal.LockUnlock.status,
  };
};
const queryDevice = async (deviceId) => {
  const data = await queryFirebase(deviceId);
  return {
    // on: data.on,
    // isPaused: data.isPaused,
    // isRunning: data.isRunning,
    // currentRunCycle: [
    //   {
    //     currentCycle: "rinse",
    //     nextCycle: "spin",
    //     lang: "en",
    //   },
    // ],
    // currentTotalRemainingTime: 1212,
    // currentCycleRemainingTime: 301,
    isLocked: data.isLocked,
    isJammed: data.isJammed,
    online: data.online,
    status: data.status,
  };
};

app.onQuery(async (body) => {
  const {requestId} = body;
  const payload = {
    devices: {},
  };
  const queryPromises = [];
  const intent = body.inputs[0];
  for (const device of intent.payload.devices) {
    const deviceId = device.id;
    queryPromises.push(
        queryDevice(deviceId).then((data) => {
          // Add response to device payload
          payload.devices[deviceId] = data;
        }),
    );
  }
  // Wait for all promises to resolve
  await Promise.all(queryPromises);
  return {
    requestId: requestId,
    payload: payload,
  };
});

const updateYaleLock = async (status) => {
  const options = {
    "method": "POST",
    "hostname": "api.littlebirdliving.com",
    // eslint-disable-next-line max-len
    "path": `/properties/${process.env.PROPERTY_ID}/units/${process.env.UNIT_ID}/panel/devices/locks/${process.env.LOCK_ID}`,
    "headers": {
      "authorization": process.env.LITTLEBIRD_AUTH_TOKEN,
      "host": "api.littlebirdliving.com",
      "content-type": "application/json",
      // eslint-disable-next-line max-len
      "user-agent": "LittleBirdNativeProd/1641525660 CFNetwork/1327.0.4 Darwin/21.2.0",
      "api-version": ">=0.8.0 <2.0.0",
      "accept": "application/json",
      "accept-language": "en-US,en;q=0.9",
      "content-length": "20",
      "accept-encoding": "gzip, deflate, br",
      "connection": "keep-alive",
    },
    "maxRedirects": 20,
  };

  const req = https.request(options, (res) => {
    const chunks = [];

    res.on("data", (chunk) => {
      chunks.push(chunk);
    });

    res.on("end", (chunk) => {
      const body = Buffer.concat(chunks);
      console.log(body.toString());
    });

    res.on("error", (error) => {
      console.error(error);
    });
  });

  const postData = JSON.stringify({
    "status": status,
  });

  req.write(postData);

  req.end();
};

const updateDevice = async (execution, deviceId) => {
  const {params, command} = execution;
  let state;
  let ref;
  switch (command) {
    case "action.devices.commands.LockUnlock":
      state = {isLocked: params.lock};
      ref = firebaseRef.child(deviceId).child("LockUnlock");
      break;
    // case "action.devices.commands.StartStop":
    //   state = {isRunning: params.start};
    //   ref = firebaseRef.child(deviceId).child("StartStop");
    //   break;
    // case "action.devices.commands.PauseUnpause":
    //   state = {isPaused: params.pause};
    //   ref = firebaseRef.child(deviceId).child("StartStop");
    //   break;
  }

  if (params.lock === true) {
    updateYaleLock("SECURED");
  } else if (params.lock === false) {
    updateYaleLock("UNSECURED");
  }

  return ref.update(state).then(() => state);
};

app.onExecute(async (body) => {
  const {requestId} = body;
  // Execution results are grouped by status
  const result = {
    ids: [],
    status: "SUCCESS",
    states: {
      online: true,
    },
  };

  const executePromises = [];
  const intent = body.inputs[0];
  for (const command of intent.payload.commands) {
    for (const device of command.devices) {
      for (const execution of command.execution) {
        executePromises.push(
            updateDevice(execution, device.id)
                .then((data) => {
                  result.ids.push(device.id);
                  Object.assign(result.states, data);
                })
                .catch(() =>
                  functions.logger.error("EXECUTE", device.id),
                ),
        );
      }
    }
  }

  await Promise.all(executePromises);
  return {
    requestId: requestId,
    payload: {
      commands: [result],
    },
  };
});

app.onDisconnect((body, headers) => {
  functions.logger.log("User account unlinked from Google Assistant");
  // Return empty response
  return {};
});

exports.smarthome = functions.https.onRequest(app);

exports.requestsync = functions.https.onRequest(async (request, response) => {
  response.set("Access-Control-Allow-Origin", "*");
  functions.logger.info(`Request SYNC for user ${USER_ID}`);
  try {
    const res = await homegraph.devices.requestSync({
      requestBody: {
        agentUserId: USER_ID,
      },
    });
    functions.logger.info("Request sync response:", res.status, res.data);
    response.json(res.data);
  } catch (err) {
    functions.logger.error(err);
    response.status(500).send(`Error requesting sync: ${err}`);
  }
});

/**
 * Send a REPORT STATE call to the homegraph when data for any device id
 * has been changed.
 */
exports.reportstate = functions.database
    .ref("{deviceId}")
    .onWrite(async (change, context) => {
      functions.logger.info("Firebase write event triggered Report State");
      const snapshot = change.after.val();

      const requestBody = {
        requestId: "ff36a3cc" /* Any unique ID */,
        agentUserId: USER_ID,
        payload: {
          devices: {
            states: {
              /* Report the current state of our lock */
              [context.params.deviceId]: {
                status: snapshot.LockUnlock.status,
                isLocked: snapshot.LockUnlock.isLocked,
                isJammed: snapshot.LockUnlock.isJammed,
                online: snapshot.LockUnlock.online,
                // on: snapshot.OnOff.on,
                // isPaused: snapshot.StartStop.isPaused,
                // isRunning: snapshot.StartStop.isRunning,
              },
            },
          },
        },
      };

      const res = await homegraph.devices.reportStateAndNotification({
        requestBody,
      });
      functions.logger.info("Report state response:", res.status, res.data);
    });

/**
 * Update the current state of the washer device
 */
exports.updatestate = functions.https.onRequest((request, response) => {
  firebaseRef.child("lock").update({
    // OnOff: {
    //   on: request.body.on,
    // },
    // StartStop: {
    //   isPaused: request.body.isPaused,
    //   isRunning: request.body.isRunning,
    // },
    LockUnlock: {
      isLocked: request.body.isLocked,
      isJammed: request.body.isJammed,
      online: request.body.online,
      status: request.body.status,
    },
  });

  return response.status(200).end();
});
