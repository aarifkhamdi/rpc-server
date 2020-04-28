import ws from 'ws'
import crypto from 'crypto'
import readline from 'readline'
import { v4 as uuid } from 'uuid'

let diffieHellman: crypto.DiffieHellman
let publicKey: string
const nameToSecret = new Map<string, Buffer>()

function encrypt(text: string, key: Buffer) {
    const secret = crypto.createHash('sha256').update(diffieHellman.computeSecret(key)).digest()
    const algorithm = 'aes-256-cbc'
    const iv = Buffer.from(crypto.randomBytes(8))
    const ivstring = iv.toString('hex')
    const cipher = crypto.createCipheriv(algorithm, secret, ivstring)
    let crypted = cipher.update(text)
    crypted = Buffer.concat([crypted, cipher.final()])
    return iv.toString('base64') + crypted.toString('base64')
}

function decrypt(text: string, key: Buffer) {
    try {
        const secret = crypto.createHash('sha256').update(diffieHellman.computeSecret(key)).digest()
        const iv = Buffer.from(text.slice(0, 12), 'base64').toString('hex')
        const data = Buffer.from(text.slice(12), 'base64')
        const decipher = crypto.createDecipheriv('aes-256-cbc', secret, iv)
        let decrypted = decipher.update(data)
        decrypted = Buffer.concat([decrypted, decipher.final()])
        return decrypted.toString()
    } catch (e) {
        return null
    }
}

const messagesToSend = new Map<string, string[]>()
const messagesBroadcast: string[] = []

const clientId = process.argv[2] ?? uuid()
console.log(`clientId is ${clientId}`)

const socket = new ws('ws://localhost:3000')
socket.on('open', () => {
    socket.once('message', message => {
        // получаем ключ сервера
        diffieHellman = crypto.createDiffieHellman(message)
        diffieHellman.generateKeys()
        publicKey = diffieHellman.getPublicKey().toString('base64')
        // отправляем свой id и ключ
        socket.send(JSON.stringify({ secret: publicKey, clientId }))
        socket.on('message', message => {
            const data = message.toString()
            let json
            try {
                json = JSON.parse(data)
            } catch (e) {
                console.log(`bad message from server, ignored ${data}`)
                return
            }
            // что-то пошло не так, просто выводим сообщение об ошибке
            if (json.action === 'error') {
                console.log(json)
            } else if (json.action === 'getKey') {
                // обмен ключами
                const secret = Buffer.from(json.secret, 'base64')
                nameToSecret.set(json.to, secret)
                const messageArray = messagesToSend.get(json.to)
                // затем отправляем все сообщения из очереди
                if (messageArray !== undefined) {
                    let message
                    while ((message = messageArray.pop()) !== undefined) {
                        socket.send(
                            JSON.stringify({
                                action: 'message',
                                to: json.to,
                                message: encrypt(message, secret),
                                secret: json.secret,
                            })
                        )
                    }
                    messagesToSend.delete(json.to)
                }
            } else if (json.action === 'getAllKeys') {
                // обновляем список адресатов
                nameToSecret.clear()
                for (const i of Object.entries<string>(json.secrets)) {
                    const secret = Buffer.from(i[1], 'base64')
                    nameToSecret.set(i[0], secret)
                    const messageArray = messagesToSend.get(i[0])
                    // отправляем сообщения, если есть
                    if (messageArray !== undefined) {
                        let message
                        while ((message = messageArray.pop()) !== undefined) {
                            socket.send(
                                JSON.stringify({
                                    action: 'message',
                                    to: i[0],
                                    message: encrypt(message, secret),
                                    secret: i[1],
                                })
                            )
                        }
                        messagesToSend.delete(json.to)
                    }
                }
                // массовая рассылка
                for (const msg of messagesBroadcast) {
                    for (const i of nameToSecret) {
                        socket.send(
                            JSON.stringify({
                                action: 'message',
                                to: i[0],
                                message: encrypt(msg, i[1]),
                                secret: i[1].toString('base64'),
                            })
                        )
                    }
                    messagesBroadcast.length = 0
                }
            } else if (json.action === 'message') {
                // получили сообщение - вывели в консоль
                const secret = Buffer.from(json.fromSecret, 'base64')
                nameToSecret.set(json.from, secret)
                console.log(JSON.stringify({message: decrypt(json.message, secret), time: json.time, from: json.from, to: clientId }))
            } else {
                // неизвестный экше, игнорм +  выводим в консоль
                console.log(`bad action ${data}`)
            }
        })
    })

    console.log('ready to work')
})

const reader = readline.createInterface({
    input: process.stdin,
})

const userInput = (answer: string) => {
    // следующее считывание
    reader.question('', userInput)

    // валидируем формат сообщения
    let json
    try {
        json = JSON.parse(answer)
    } catch (e) {
        console.log(`bad message:\n${answer}`)
        return
    }
    if (json === null || typeof json !== 'object') {
        console.log(`bad message:\n${answer}`)
        return
    }
    const jsonKeys = Object.keys(json)
    if (!(jsonKeys.length === 2 && typeof json.to === 'string' && typeof json.message === 'string')) {
        console.log(`bad message:\n${answer}`)
        return
    }

    // если массовая рассылка - записываем в очередь сообщений и получаем список адресатов
    if (json.to === '-1') {
        messagesBroadcast.push(json.message)
        socket.send(JSON.stringify({ action: 'getAllKeys' }))
    } else {
        // если уже происходил обмен ключами - отправляем сообщение
        const toSecret = nameToSecret.get(json.to)
        if (toSecret !== undefined) {
            socket.send(
                JSON.stringify({
                    action: 'message',
                    to: json.to,
                    message: encrypt(json.message, toSecret!),
                    secret: toSecret.toString('base64'),
                })
            )
        } else {
            // иначе ставим сообщение в очередь и запрашиваем обмен ключами
            let messageQueue = messagesToSend.get(json.to)
            if (messageQueue === undefined) {
                messageQueue = []
                messagesToSend.set(json.to, messageQueue)
            }
            messageQueue.push(json.message)
            socket.send(JSON.stringify({ action: 'getKey', to: json.to }))
        }
    }
}

reader.question('', userInput)
