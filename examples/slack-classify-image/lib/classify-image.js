'use strict';

const fs = require('fs');
const request = require('request');
const SlackWebClient = require('@slack/client').WebClient;
const jimp = require('jimp');

module.exports = classifyImage;

/**
 * @param {FaasEvent} event
 * @param {FaasContext} context
 * @return {Promise|*}
 */
function classifyImage(event, context) {

    // https://api.sap.com/api/image_classification_api/overview

    const LEONARDO_API_KEY = context.getSecretValueString('slack-classify-image', 'leonardoApiKey');
    const LEONARDO_ENDPOINT = 'https://sandbox.api.sap.com/ml/imageclassification/classification';
    const leonardo = {
        endpoint : LEONARDO_ENDPOINT,
        apiKey : LEONARDO_API_KEY,
        pixelLimit : 990000
    };

    // https://api.slack.com/slack-apps#creating_apps
    const SLACK_CLIENT_TOKEN = context.getSecretValueString('slack-classify-image', 'slackToken');
    const slack = {
        client : new SlackWebClient(SLACK_CLIENT_TOKEN),
        token : SLACK_CLIENT_TOKEN,
    };

    let file, cType;

    switch (event.data.event.type) {
        case 'file_shared':  // https://api.slack.com/events/file_shared
            return slack.client.files.info({ file: event.data.event.file.id, count: 0 })
                // check created file
                .then((fileDesc) => new Promise((resolve, reject) => {
                    file = fileDesc.file;
                    request({
                        url: file.url_private,
                        encoding: null,
                        headers: { 'Authorization': 'Bearer ' + slack.token }
                    }, (err, response, body) => {
                        if (err) reject(err);
                        cType = response.headers['content-type'];
                        if (!cType.startsWith('image')) reject(new Error(`file mime type ${cType}not supported`));

                        jimp.read(body).then((image) => {
                            resolve(image);
                        }).catch((err) => {
                            reject(err);
                        });
                    });
                }))

                // resize image if needed
                .then((image) => {
                    const ratio = image.bitmap.height * image.bitmap.width / leonardo.pixelLimit;
                    if(ratio > 1){
                        image = image.scale(ratio, jimp.AUTO);
                    }
                    return image.getBufferAsync(jimp.AUTO);
                })

                // post final image to leonardo
                .then((imgFinal) => new Promise((resolve, reject) => {
                    request.post({
                        url: leonardo.endpoint,
                        headers: {
                            'Accept': 'application/json',
                            'APIKey': leonardo.apiKey,
                        },
                        formData: {
                            files: {
                                value: imgFinal,
                                options:{
                                    contentType: cType,
                                    filename : file.name
                                }
                            }
                        },
                        preambleCRLF: true,
                        postambleCRLF: true,

                    }, (err, response, body) => {
                        if (err) reject(err);
                        if(response.statusCode === 200) {
                            resolve(JSON.parse(body));
                        }
                        else {
                            reject();
                        }
                    });
                }))

                // create slack message from leonardo prediction
                .then((data) => {
                    const results = (data.predictions.length === 0) ? [] : data.predictions[0].results.reduce(function(result, current) {
                        result.push(`${current.label} with score ${current.score}`);
                        return result;
                    }, []);
                    const message = `Leonardo thinks image ${file.name} contains ${results.length ? ':\n' + results.join('\n') : ' nothing'}`;

                    return slack.client.chat.postMessage({
                        channel: file.channels[0],
                        text: message
                    });
                })

                .catch( (err) => {
                    console.log('error during image classification ' + err);
                });
        default:
            console.log(`unknown event "${event.data.event.type}" received`);
    }

}

