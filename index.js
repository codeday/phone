//const http = require('srnd-microservices/http')
const { GoogleSpreadsheet } = require('google-spreadsheet')
const VoiceResponse = require('twilio').twiml.VoiceResponse
const moment = require('moment-timezone');
const express = require('express');

const app = express();

function isBusinessHours() {
    const currentHour = moment().utc().tz('America/Los_Angeles').hours();
    return (currentHour >= 7 && currentHour < 17);
}

async function getNumberForExtension(ext) {
    const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET);
    await googleLogin(doc);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    const rows = (await sheet.getRows({
      offset: 1,
    })).filter((row) => row.ext === ext);

    if (typeof(rows) === 'undefined' || rows === null || rows.length == 0) return null;
    return {
        "description": rows[0].description,
        "number": rows[0].phone,
        "direct": rows[0].direct
    };
}

async function googleLogin(sheet) {
  await sheet.useServiceAccountAuth({
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: atob(process.env.GOOGLE_PRIVATE_KEY),
  });
}

app.all('/', async (req, res) => {
  const response = new VoiceResponse();
  response
      .gather({action: '/dial', method: 'GET'})
      .play({loop:4}, 'https://f1.srnd.org/phone/codeday-greeting-2021-01.mp3');
  response.hangup();

  res.send(response.toString());
});

app.all('/dial', async (req, res) => {
  try {
    const digits = req.query.Digits.replace(/[^0-9]*/g, '');
    const response = new VoiceResponse();
    const phoneInfo = await getNumberForExtension(digits);

    if (phoneInfo && phoneInfo.number && phoneInfo.number.substr(0,3) === 'qa:') {
      response.say({voice:"woman"}, 'Please stay on the line and we will connect you to callers as they join the queue.');
      response.dial().queue(phoneInfo.number.substr(3));
      response.redirect();
    } else if (phoneInfo && phoneInfo.number && phoneInfo.number.substr(0,2) === 'q:') {
      response.enqueue({
        waitUrl: '/queue',
      }, phoneInfo.number.substr(2));
    } else if (phoneInfo && phoneInfo.number) {
        let toDial = phoneInfo.number;
        if (toDial.indexOf(',') !== -1) {
          const allDials = toDial.split(',');
          toDial = allDials[Math.floor(Math.random() * allDials.length)].replace(/[^0-9]/g, '');
        }

        if (phoneInfo.direct && phoneInfo.direct !== "" && phoneInfo.direct !== "no") {
            response.dial().number(toDial);
        } else {
            response.play('https://f1.codeday.org/phone/connecting.mp3');
            response.dial().number({
                url: 'https://codeday-phone.fly.dev/connect?connectFor='+encodeURIComponent(phoneInfo.description),
                method: 'GET'
            }, toDial);
        }
    } else {
        response.play('https://f1.codeday.org/phone/invalid.mp3');
        response.redirect({method: 'get'}, '/phone');
    }

    res.send(response.toString());
  } catch (ex) {
    console.error(ex);
    res.send('');
  }
});

app.all('/connect', async (req, res) => {
    const response = new VoiceResponse();
    response.play('https://f1.codeday.org/phone/incoming-codeday.mp3');
    response.say({voice: "woman"}, req.query.connectFor);
    response.play('https://f1.codeday.org/phone/incoming-srnd-end.mp3');
    res.send(response.toString());
});

app.all('/codeday', async (req, res) => {
    const response = new VoiceResponse();
    response.play('https://f1.codeday.org/phone/codeday-closed.mp3');
    res.send(response.toString());
    response.hangup();
    res.send(response.toString());
});

app.all('/queue', async (req, res) => {
  const response = new VoiceResponse();
  if (req.query.QueuePosition) {
    response.say({voice:"woman"}, `Thank you for your patience, you are caller number ${req.query.QueuePosition} in the queue.`);
  }
  response.play('https://f1.codeday.org/phone/queue_hold.mp3');
  res.send(response.toString());
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`Listening on http://0.0.0.0:${port}`))
