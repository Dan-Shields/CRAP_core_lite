import { createInterface } from 'readline'
import { Chess } from 'chess.js'
import chalk from 'chalk'
import { SerialPort } from 'serialport'

const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
})

const chess = new Chess()

const SERIAL_OPS = {
    READ_ANGLE: 0x80,
    READ_POS: 0x81,
    CORNER_DEF: 0x82,
    MOVE_CHESS_COORD: 0x83,
    MOVE_PIECE: 0x84,
    TAKE_PIECE: 0x85,
    MOVE: 0x02,
    MOVE_ANGLES: 0x05,
}

const ACK_TYPE = {
    NACK: 0x01,
    ACK: 0x02,
    MSG: 0xff,
}

const NACK_TYPE = {
    OP: 0xff,
    SUM: 0xfe,
    ARG: 0xfd,
    NOGOAL: 0xfc,
}

const BYTESIZE = 8,
    PARITY = 'N',
    STOPBITS = 1,
    com = 'COM6',
    baudRate = 9600

let port

function initSerial() {
    port = new SerialPort({
        path: com,
        baudRate,
        parity: PARITY,
        stopBits: STOPBITS,
    })

    port.on('error', (e) => {
        console.error(`Serial Error: ${e}`)
    })
}

async function portReadable() {
    return new Promise((resolve, reject) => {
        port.on('readable', () => {
            resolve()
        })
    })
}

function readSerialMsg() {
    let len
    while (!(len = port.read(1))) continue
    msg = port.read(len[0])
    console.log(`M: ${msg}`)
}

async function writeSerial(op, data = new Uint8Array([])) {
    console.log(`sending serial command: 0x${op.toString(16)}, data: ${data}`)

    const pkt = new Uint8Array([
        op,
        data.length,
        ...data,
        data.length ? data.reduce((a, b) => a + b) & 0xff : 0,
    ])

    const writeResult = port.write(pkt, 'hex', (e) => {
        if (e) console.error(`error while writing: ${e}`)
    })

    await portReadable()

    let ack
    while ((ack = port.read(1)[0]) === ACK_TYPE.MSG) readSerialMsg()

    // console.log(ack)

    if (ack != ACK_TYPE.ACK) throw Error(NACK_TYPE[port.read(1)?.[0]])

    if (op === 0x80 || op === 0x81) {
        let len
        await portReadable()
        while (!(len = port.read(1))) continue
        return port.read(len[0])
    }
}

const chess = new Chess()

function printGameStatus() {
    console.log(chalk.underline('\nCurrent board:'))

    console.log(chess.ascii())

    console.log('')

    console.log(
        `${chalk.underline(chess.turn() == 'w' ? 'White' : 'Black')} to move`
    )
}

function anToCoord(an) {
    return [an.charCodeAt(0) - 97, parseInt(an[1] - 1)]
}

function tryMove(_move) {
    try {
        const move = chess.move(_move)

        // standard capture
        if (move.captured && !move.flags.includes('e')) {
            writeSerial(
                SERIAL_OPS.TAKE_PIECE,
                new Uint8Array(anToCoord(move.to))
            )
        }

        if (move.promotion) {
            // remove pawn
            writeSerial(
                SERIAL_OPS.TAKE_PIECE,
                new Uint8Array(anToCoord(move.from))
            )

            // move promotion piece to promotion square
            writeSerial(
                SERIAL_OPS.MOVE_PIECE,
                new Uint8Array([
                    move.color == 'w' ? -1 : 8,
                    0,
                    ...anToCoord(move.to),
                ])
            )
        } else {
            // standard move
            writeSerial(
                SERIAL_OPS.MOVE_PIECE,
                new Uint8Array([...anToCoord(move.from), ...anToCoord(move.to)])
            )
        }

        // en-passant capture
        if (move.flags.includes('e')) {
            const coords = anToCoord(move.to)

            coords[1] += move.color == 'w' ? -1 : 1

            writeSerial(SERIAL_OPS.TAKE_PIECE, new Uint8Array(coords))
        }

        // castling
        if (move.flags.includes('k') || move.flags.includes('q')) {
            const from = [
                move.flags.includes('k') ? 7 : 0,
                move.color == 'w' ? 0 : 7,
            ]
            const to = [
                move.flags.includes('k') ? 5 : 0,
                move.color == 'w' ? 0 : 7,
            ]
            writeSerial(SERIAL_OPS.MOVE_PIECE, new Uint8Array([...from, ...to]))
        }
    } catch (e) {
        return e
    }
}

// reset game to start
async function reset() {
    return new Promise((res, rej) => {
        readline.question(chalk.red('Are you sure? (y/n)'), (answer) => {
            if (answer == 'y' || answer == 'Y') {
                chess.reset()

                process.stdout.write('\u001b[2J\u001b[0;0H')
            }

            res()
        })
    })
}

function promptCommand() {
    readline.question(chalk.green(`Input command: `), async (command) => {
        if (!command || typeof command !== 'string') {
            promptCommand()
            return
        }

        let result = ''

        const commParts = command.split(' ')

        const op = commParts[0]

        switch (op) {
            case 'help':
                result = chalk.bold.underline('\nChessBot Help:\n')
                let helpText = 'help \t\t Display this text.\n'

                helpText += `reset\t\t Reset board to start of game.\n`

                helpText += `${chalk.italic(
                    'move_string'
                )}\t Use no command name to make a move. See https://www.npmjs.com/package/chess.js#move---permissive-parser for details\n`

                result += chalk.cyan(helpText)
                break

            case 'reset':
                if (commParts.length !== 1) {
                    result = chalk.red(
                        `"reset" command expects 0 args but got ${
                            commParts.length - 1
                        }`
                    )
                } else {
                    await reset()
                }
                break

            default:
                if (commParts.length !== 1) {
                    result = chalk.red(
                        `To move input a single argument (got ${
                            commParts.length - 1
                        } args)`
                    )
                } else {
                    const res = tryMove(commParts[0])

                    if (res) {
                        result = chalk.red(`Invalid move "${commParts[0]}"\n`)
                        result += chalk.yellow(
                            'Type "help" to see list of available commands'
                        )
                    }
                }
                break
        }

        printGameStatus()

        console.log(result)

        promptCommand()
    })
}

initSerial()

printGameStatus()

console.log(chalk.cyan('\nType "help" to see list of available commands'))

promptCommand()
