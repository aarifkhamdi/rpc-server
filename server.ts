import ws from 'ws'
import crypto from 'crypto'

const nameToSocket = new Map<string, ws>() // используется для отправки сообщения по имени устройства
const socketToName = new Map<ws, string>() // используется для определения имени отправителя
const nameToSecret = new Map<string, string>() // используется для получения секрета по имени приложения

const KEY_LENGTH = 1024
const diffieHellman = crypto.createDiffieHellman(KEY_LENGTH)
const prime = diffieHellman.getPrime()

const server = new ws.Server({ host: '0.0.0.0', port: 3000 }, () => console.log('server ready'))

server.on('connection', ws => {
    // отправляем секрет для диффи-хеллмана
    ws.send(prime)

    // отключаем веб-сокет и удаляем информацию об используемом им имени
    ws.once('close', () => {
        const name = socketToName.get(ws)
        socketToName.delete(ws)
        if (name !== undefined) {
            nameToSocket.delete(name)
            nameToSecret.delete(name)
        }
        ws.terminate()
    })

    // получаем название приложения и секрет
    ws.once('message', message => {
        let json
        try {
            json = JSON.parse(message)
        } catch (e) {
            ws.close(undefined, `bad data ${message}. it must be object with keys [name, secret]`)
            return
        }
        if (json === null || typeof json !== 'object') {
            ws.close(undefined, `bad data ${message}. it must be object with keys [name, secret]`)
            return
        }
        if (Object.keys(json).length !== 2) {
            ws.close(undefined, `bad data ${message}. it must be object with keys [name, secret]`)
            return
        }
        const { clientId, secret } = json
        if (typeof clientId !== 'string') {
            ws.close(undefined, 'name must be a string')
            return
        }
        if (typeof secret !== 'string') {
            ws.close(undefined, 'name must be a string')
            return
        }
        if (clientId === '') {
            ws.close(undefined, 'name cant be empty')
            return
        }
        if (nameToSocket.has(clientId)) {
            ws.close(undefined, `name ${clientId} alredy in use`)
            return
        }
        nameToSocket.set(clientId, ws)
        socketToName.set(ws, clientId)
        nameToSecret.set(clientId, secret)

        // запускаем месседжинг
        ws.on('message', message => {
            const data = message.toString()
            // валидируем формат сообщения
            let json
            try {
                json = JSON.parse(data)
            } catch (e) {
                ws.send(JSON.stringify({ action: 'error', message: `bad message: ${data}` }))
                return
            }
            if (json === null || typeof json !== 'object') {
                ws.send(JSON.stringify({ action: 'error', message: `bad message: ${data}` }))
                return
            }
            const jsonKeys = Object.keys(json)
            if (json.action === 'getKey') {
                // обмен ключами
                if (jsonKeys.length !== 2) {
                    ws.send(JSON.stringify({ action: 'error', message: `bad message: ${data}` }))
                    return
                }
                if (typeof json.to !== 'string') {
                    ws.send(JSON.stringify({ action: 'error', message: '"to" must be a string' }))
                    return
                }
                if (json.to === socketToName.get(ws)) {
                    ws.send(JSON.stringify({ action: 'delKey', message: `cant send message to yourself`, to: json.to }))
                    return
                }
                const secret = nameToSecret.get(json.to)
                if (secret === undefined) {
                    ws.send(JSON.stringify({ action: 'delKey', message: `cant find to ${json.to}, no such user`, to: json.to }))
                } else {
                    ws.send(JSON.stringify({ action: 'getKey', secret, to: json.to }))
                }
            } else if (json.action === 'getAllKeys') {
                // запрос всех адресатов
                const secrets = Object.fromEntries(nameToSecret)
                delete secrets[socketToName.get(ws)!] // удаляем свой секрет из результата
                ws.send(JSON.stringify({
                    action: 'getAllKeys',
                    secrets,
                }))
            } else if (json.action === 'message') {
                // отправка сообщения  юзеру
                if (!(jsonKeys.length === 4 && typeof json.to === 'string' && typeof json.message === 'string' && typeof json.secret === 'string')) {
                    ws.send(JSON.stringify({ action: 'error', message: `bad message:${data}` }))
                    return
                }

                const target = nameToSecret.get(json.to)
                if (target === undefined) {
                    ws.send(JSON.stringify({ action: 'delKey', message: `cant send message to ${json.to} coz it does not exists`, to: json.to }))
                    return
                }
                if (json.secret !== target) {
                    ws.send(JSON.stringify({ action: 'error', message: `cant send message to ${json.to} coz bad secret` }))
                    ws.send(JSON.stringify({ action: 'getKey', to: json.to, secret: target }))
                    return
                }

                // отправка сообщения к адресатам
                const sock = nameToSocket.get(json.to)!
                if (sock === ws) {
                    ws.send(
                        JSON.stringify({
                            action: 'error',
                            message: `cant send message to youself ${data}`,
                            to: json.to,
                        })
                    )
                } else {
                    sock.send(
                        JSON.stringify({
                            action: 'message',
                            from: socketToName.get(ws)!,
                            message: json.message,
                            time: Date.now(),
                            fromSecret: nameToSecret.get(socketToName.get(ws)!)!,
                        })
                    )
                }
            } else {
                ws.send(JSON.stringify({ action: 'error', message: `bad action ${data}` }))
            }
        })
    })
})
