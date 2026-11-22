import { createServer, type AddressInfo, type Server } from 'node:net';
import { SmtpEmailSender } from '../../../src/infrastructure/email/SmtpEmailSender';

/** Minimal SMTP server (plain, no auth) that records each received message. */
function startSmtpServer(): Promise<{ server: Server; port: number; messages: string[] }> {
  const messages: string[] = [];
  const server = createServer((socket) => {
    let inData = false;
    let data = '';
    let buffer = '';
    socket.write('220 test ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(data);
            data = '';
            socket.write('250 OK queued\r\n');
          } else {
            data += `${line}\n`;
          }
          continue;
        }
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'EHLO' || command === 'HELO') socket.write('250 test\r\n');
        else if (command === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (command === 'QUIT') {
          socket.end('221 bye\r\n');
        } else socket.write('250 OK\r\n');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as AddressInfo).port, messages }),
    );
  });
}

describe('SmtpEmailSender', () => {
  it('delivers over SMTP with a stable Message-ID derived from the idempotency key', async () => {
    const { server, port, messages } = await startSmtpServer();
    try {
      const sender = new SmtpEmailSender(
        { host: '127.0.0.1', port, secure: false, user: undefined, pass: undefined } as never,
        'TicketFlow <no-reply@ticketflow.test>',
      );
      await sender.send({
        to: 'customer@example.com',
        subject: 'Your TicketFlow tickets: Rock Night',
        text: 'Booking ID: b-1',
        idempotencyKey: 'BOOKING_CONFIRMED:b-1:EMAIL',
      });
      expect(messages).toHaveLength(1);
      const raw = messages[0]!;
      expect(raw).toMatch(/^To: customer@example\.com$/m);
      expect(raw).toMatch(/^From: TicketFlow <no-reply@ticketflow\.test>$/m);
      expect(raw).toMatch(/^Subject: Your TicketFlow tickets: Rock Night$/m);
      expect(raw).toMatch(/^Message-ID: <BOOKING.CONFIRMED.b-1.EMAIL@ticketflow>$/m);
      expect(raw).toContain('Booking ID: b-1');
    } finally {
      server.close();
    }
  });

  it('rejects when the server is unreachable so the outbox retries', async () => {
    const sender = new SmtpEmailSender(
      { host: '127.0.0.1', port: 1, secure: false } as never,
      'no-reply@ticketflow.test',
    );
    await expect(sender.send({ to: 'a@example.com', subject: 's', text: 't' })).rejects.toThrow();
  });
});
