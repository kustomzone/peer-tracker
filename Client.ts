"use strict";

import { EventEmitter }   from "events";
import * as writeUInt64BE from "writeuint64be";
import * as WebSocket     from "ws";
import { Buffer }         from "buffer";
import * as dgram         from "dgram";

const debug            = require("debug")("PeerTracker:Client"),
      ACTION_CONNECT   = 0,
      ACTION_ANNOUNCE  = 1,
      ACTION_SCRAPE    = 2,
      ACTION_ERROR     = 3;
let   connectionIdHigh = 0x417,
      connectionIdLow  = 0x27101980;

function udp(announcement: string, trackerHost: string, port: number, myPort: number, infoHash: string | Array<string>, left: number, uploaded: number, downloaded: number) {
  return new Client("udp", announcement, trackerHost, port, myPort, infoHash, left, uploaded, downloaded);
}

function ws(announcement: string, trackerHost: string, port: number, myPort: number, infoHash: string | Array<string>, left: number, uploaded: number, downloaded: number) {
  return new Client("ws", announcement, trackerHost, port, myPort, infoHash, left, uploaded, downloaded);
}

class Client extends EventEmitter {
  _debugId:       number;
  TYPE:           string;
  USER:           string;
  CASE:           string;
  HOST:           string;
  HASH:           string | Array<string>;
  PORT:           number;
  MY_PORT:        number;
  TRANSACTION_ID: number;
  EVENT:          number;
  SCRAPE:         boolean;
  DOWNLOADED:     number;
  LEFT:           number;
  UPLOADED:       number;
  KEY:            number;
  IP_ADDRESS:     number;
  TIMEOUTS:       Array<any>;
  TIMEOUTS_DATE:  number;
  TIMEOUT_N:      number;
  server:         any;

  constructor(type: string, announcement: string, trackerHost: string, port: number, myPort: number, infoHash: string | Array<string>, left: number, uploaded: number, downloaded: number) {
    super();
    if (!(this instanceof Client))
      return new Client(type, announcement, trackerHost, port, myPort, infoHash, left, uploaded, downloaded);
    const self = this;

    self._debugId = ~~((Math.random() * 100000) + 1);
    self._debug("peer-tracker Client instance created");
    self.TYPE = type;
    self.USER = "-EM0012-" + guidvC();
    self.CASE = announcement;
    self.HOST = trackerHost;
    self.HASH = ( Array.isArray(infoHash) ) ? infoHash.join("") : infoHash;
    self.PORT = port;
    self.MY_PORT = myPort;
    self.TRANSACTION_ID = null; // This will be our method of keeping track of new connections...
    self.EVENT = 0;

    self.LEFT       = left;
    self.UPLOADED   = uploaded;
    self.DOWNLOADED = downloaded;
    self.KEY        = 0;
    self.IP_ADDRESS = 0;        // Default unless behind a proxy

    self.SCRAPE     = false;

    // Setup server

    if (self.TYPE === "udp") {
      self.server = dgram.createSocket("udp4");
      self.server.on("listening", function () {
        self.prepAnnounce();
      });
      self.server.on("message", function (msg, rinfo) { self.message(msg, rinfo); });
      self.server.bind();
    } else {
      self.HOST = "ws://" + self.HOST + ":" + self.PORT;
      self.server = new WebSocket( self.HOST );
      self.server.on("open", function () {
        self.prepAnnounce();
      });
      self.server.on("message", function(msg, flags) { self.message(msg, flags); });
    }

  }

  prepAnnounce() {
    const self = this;
    switch (self.CASE) {
      case "start":
        self._debug("start (EVENT 2) called");
        self.EVENT = 2;
        break;
      case "stop":
        self._debug("stop (EVENT 3) called");
        self.EVENT = 3;
        setTimeout(() => {
          // Close the server
          self.server.close();
        }, 1500);
        break;
      case "complete":
        self._debug("complete (EVENT 1) called");
        self.EVENT = 1;
        break;
      case "update":
        self._debug("update (EVENT 0) called");
        self.EVENT = 0;
        break;
      case "scrape":
        self._debug("scrape (EVENT 2) called");
        self.SCRAPE = true;
        self.EVENT  = 2;
        self.scrape();
        return;
      default:
        self.emit("error", "Bad call signature.");
        return;
    }
    self.announce();
  }

  sendPacket(buf: Buffer) {
    const self = this;
    self._debug("send packet");
    if (self.TYPE === "udp") {
      self.server.send(buf, 0, buf.length, self.PORT, self.HOST, (err) => {
          if (err) { self.emit("error", err); }
      });
    } else {
      self.server.send(buf);
    }
  }

  startConnection() {
    const self = this;
    self._debug("Begin Connection");
    // Prepare for the next connection:
    self.TRANSACTION_ID = ~~( (Math.random() * 100000) + 1);

    // Prep a packet for delivery:
    let buf = new Buffer(16);
    buf.fill(0);

    buf.writeUInt32BE(connectionIdHigh, 0);      // 0    64-bit integer  connection_id   0x41727101980
    buf.writeUInt32BE(connectionIdLow, 4);       // 0    64-bit integer  connection_id   0x41727101980
    buf.writeUInt32BE(ACTION_CONNECT, 8);        // 8    32-bit integer  action          0 // connect
    buf.writeUInt32BE(self.TRANSACTION_ID, 12);  // 12   32-bit integer  transaction_id

    // Send packet
    self.sendPacket(buf);
  }

  scrape() {
    const self = this;
    self._debug("scrape");
    if (!self.TRANSACTION_ID) {
        self.startConnection();
    } else {

      let hashBuf = Buffer.from(self.HASH, "hex");
      let buf = new Buffer(16);
      buf.fill(0);

      buf.writeUInt32BE(connectionIdHigh, 0);      // 0             64-bit integer  connection_id   0x41727101980
      buf.writeUInt32BE(connectionIdLow, 4);       // 0             64-bit integer  connection_id   0x41727101980
      buf.writeUInt32BE(ACTION_SCRAPE, 8);         // 8             32-bit integer  action          2 // scrape
      buf.writeUInt32BE(self.TRANSACTION_ID, 12);  // 12            32-bit integer  transaction_id
      buf = Buffer.concat([buf, hashBuf]);         // 16 + 20 * n   20-byte string  info_hash
      // Send Packet
      self.sendPacket(buf);
    }

  }

  announce() {
    // EVENT: 0: none; 1: completed; 2: started; 3: stopped
    const self = this;
    self._debug("announce");
    if (!self.TRANSACTION_ID) {
        self.startConnection();
    } else {
      // Prepare announce packet for delivery
      let buf = new Buffer(98);
      buf.fill(0);

      buf.writeUInt32BE(connectionIdHigh, 0);     //   0    64-bit integer  connection_id
      buf.writeUInt32BE(connectionIdLow, 4);      //   0    64-bit integer  connection_id
      buf.writeUInt32BE(ACTION_ANNOUNCE, 8);      //   8    32-bit integer  action          1 // announce
      buf.writeUInt32BE(self.TRANSACTION_ID, 12); //   12   32-bit integer  transaction_id
      buf.write(self.HASH, 16, 20, "hex");        //   16   20-byte string  info_hash
      buf.write(self.USER, 36, 20);               //   36   20-byte string  peer_id
      writeUInt64BE(buf, self.DOWNLOADED, 56);    //   56   64-bit integer  downloaded
      writeUInt64BE(buf, self.LEFT, 64);          //   64   64-bit integer  left
      writeUInt64BE(buf, self.UPLOADED, 72);      //   72   64-bit integer  uploaded
      buf.writeUInt32BE(self.EVENT, 80);          //   80   32-bit integer  event           0 // 0: none; 1: completed; 2: started; 3: stopped
      buf.writeUInt32BE(self.IP_ADDRESS, 84);     //   84   32-bit integer  IP address      0 // default
      buf.writeUInt32BE(self.KEY, 88);            //   88   32-bit integer  key
      buf.writeInt32BE((-1), 92);                 //   92   32-bit integer  num_want        -1 // default
      buf.writeUInt16BE(self.MY_PORT, 96);        //   96   16-bit integer  port

      // Send Packet
      self.sendPacket(buf);

      self.TRANSACTION_ID = null;
      connectionIdHigh    = 0x417,
      connectionIdLow     = 0x27101980;
    }
  }

  message(msg: string | Buffer, rinfo: Object) {
    const self = this;
    let buf;
    if (!Buffer.isBuffer(msg))
      buf = new Buffer(msg);
    else
      buf = msg;

    let action = buf.readUInt32BE(0);            // 0   32-bit integer  action   0 // connect 1 // announce 2 // scrape 3 // error
    self.TRANSACTION_ID = buf.readUInt32BE(4);   // 4   32-bit integer  transaction_id
    if (action === ACTION_CONNECT) {
      self._debug("message connect");
      // Server will establish a new connection_id to talk on.
      // This connection_id dies after 5-10 seconds.
      connectionIdHigh = buf.readUInt32BE(8);     // 0   64-bit integer  connection_id
      connectionIdLow  = buf.readUInt32BE(12);    // 0   64-bit integer  connection_id

      // Announce
      if (self.SCRAPE)
        self.scrape();
      else
        self.announce();

    } else if (action === ACTION_SCRAPE) {
      self._debug("message scrape");
      for (let i = 0; i < (buf.length - 8); i += 20) {
        let seeders   = buf.readUInt32BE(8 + i),   //  8    32-bit integer  interval
            completed = buf.readUInt32BE(12 + i),  //  12   32-bit integer  completed
            leechers  = buf.readUInt32BE(16 + i);  //  16   32-bit integer  leechers
        self.emit("scrape", seeders, completed, leechers);
      }
      self.announce();

    } else if (action === ACTION_ANNOUNCE) {
      self._debug("message announce");
      let interval  = buf.readUInt32BE(8),   //  8           32-bit integer  interval
          leechers  = buf.readUInt32BE(12),  //  12          32-bit integer  leechers
          seeders   = buf.readUInt32BE(16),  //  16          32-bit integer  seeders
          bufLength = buf.length,            //  20 + 6 * n  32-bit integer  IP address
          addresses = [];                    //  24 + 6 * n  16-bit integer  TCP port

      for (let i = 20; i < bufLength; i += 6) {
        let address = `${buf.readUInt8(i)}.${buf.readUInt8(i + 1)}.${buf.readUInt8(i + 2)}.${buf.readUInt8(i + 3)}:${buf.readUInt16BE(i + 4)}`;
        addresses.push(address);
      }
      // Send up
      self.emit("announce", interval, leechers, seeders, addresses);
      // Close the server
      self.server.close();

    } else if (action === ACTION_ERROR) {
      self._debug("message error");
      let errorResponce = buf.slice(8).toString();
      self.emit("error", errorResponce);

      // Close the server
      self.server.close();
    }
  }

  _debug = (...args: any[]) => {
    args[0] = "[" + this._debugId + "] " + args[0];
    debug.apply(null, args);
  }

}

function guidvC() {
    return Math.floor((1 + Math.random()) * 0x1000000000000)
      .toString(16)
      .substring(1);
}

export { udp, ws };
