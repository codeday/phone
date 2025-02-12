//const http = require('srnd-microservices/http')
const { GoogleSpreadsheet } = require('google-spreadsheet')
const VoiceResponse = require('twilio').twiml.VoiceResponse
const moment = require('moment-timezone');
const express = require('express');
const bodyParser = require('body-parser');
const { phone } = require('phone');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const UPDATE_LOCALES_QUERY = `
query PhoneLocales {
  cms {
    localizationConfigs {
      items {
        iso3166Alpha2Code
        iso3166Alpha3Code
        e164CountryCode
        inboundPhoneNumbers
        phoneGreetingAudio { contentfulBaseUrl }
        phoneInvalidAudio { contentfulBaseUrl }
        phoneConnectingAudio { contentfulBaseUrl }
      }
    }
  }
}
`;
let locales = [];
let localesByAlpha2 = {};
let localesByAlpha3 = {};
let localesByE164 = {};
let localesByInboundPhoneNumber = {};
async function updateLocales() {
  try {
    const response = await fetch("https://graph.codeday.org/", {
      body: JSON.stringify({ operationName: 'PhoneLocales', variables: {}, query: UPDATE_LOCALES_QUERY }),
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json'
      }
    });

    const data = await response.json();
    locales = data.data.cms.localizationConfigs.items;
    localesByAlpha2 = Object.fromEntries(locales.map(l => [l.iso3166Alpha2Code.toUpperCase(), l]));
    localesByAlpha3 = Object.fromEntries(locales.map(l => [l.iso3166Alpha3Code.toUpperCase(), l]));
    localesByE164 = Object.fromEntries(locales.map(l => [l.e164CountryCode, l]));
    localesByInboundPhoneNumber = Object.fromEntries(locales.flatMap(l => (l.inboundPhoneNumbers || []).map(n => [n, l])));
    console.log('Updated locales.');
  } catch (ex) {
    console.error('Could not update locales.');
  }
}

function fetchLocaleConfig(req) {
  const fromCountry = (req.query?.FromCountry || req.body?.FromCountry)?.toUpperCase();
  const fromPhone = req.query?.From || req.body?.From;
  const fromE164 = fromPhone ? phone(fromPhone)?.countryCode.slice(1) : null;
  const to = req.query?.To || req.body?.To;

  if (fromCountry && fromCountry.length == 2 && fromCountry in localesByAlpha2) {
    return localesByAlpha2[fromCountry];
  } else if (fromCountry && fromCountry.length == 3 && fromCountry in localesByAlpha3) {
    return localesByAlpha3[fromCountry];
  } else if (fromE164 && fromE164 in localesByE164) {
    return localesByE164[fromE164];
  } else if (to && to in localesByInboundPhoneNumber) {
    return localesByInboundPhoneNumber[to];
  } else {
    return localesByAlpha2['US'];
  }
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
  const { phoneGreetingAudio } = fetchLocaleConfig(req);
  const response = new VoiceResponse();
  const gather = response.gather({action: '/dial', method: 'GET'});
  for (let i = 0; i < 3; i++) {
    gather.play({}, phoneGreetingAudio.contentfulBaseUrl);
    gather.pause({length: 3});
  }
  response.hangup();

  res.send(response.toString());
});

app.all('/dial', async (req, res) => {
  try {
    const { phoneInvalidAudio, phoneConnectingAudio } = fetchLocaleConfig(req);
    const digits = req.query.Digits.replace(/[^0-9]*/g, '');
    const response = new VoiceResponse();
    const phoneInfo = await getNumberForExtension(digits);

    if (phoneInfo && phoneInfo.number && phoneInfo.number.substr(0,3) === 'qa:') {
      response.say({voice:"woman"}, 'You\'re connected to the queue.');
      response.dial().queue(phoneInfo.number.substr(3));
      response.redirect({ method: 'GET' }, `/dial?Digits=${req.query.Digits}`);
    } else if (phoneInfo && phoneInfo.number && phoneInfo.number.substr(0,2) === 'q:') {
      response.say({voice:"woman"}, 'Please stay on the line and we will connect you as soon as we can.');
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
            response.play(phoneConnectingAudio.contentfulBaseUrl);
            response.dial().number({
                url: 'https://codeday-phone.fly.dev/connect?connectFor='+encodeURIComponent(phoneInfo.description),
                method: 'GET'
            }, toDial);
        }
    } else {
        response.play(phoneInvalidAudio.contentfulBaseUrl);
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

app.all('/queue', async (req, res) => {
  const response = new VoiceResponse();
  if (req.query.QueuePosition) {
    response.say({voice:"woman"}, `Thank you for your patience, you are caller number ${req.query.QueuePosition} in the queue.`);
  }
  response.play('https://f1.codeday.org/phone/queue_hold.mp3');
  res.send(response.toString());
});

(async () => {
  await updateLocales();
  setInterval(updateLocales, 1000 * 60 * 15);
  const port = process.env.PORT || 8080;
  app.listen(port, () => console.log(`Listening on http://0.0.0.0:${port}`))
})();
