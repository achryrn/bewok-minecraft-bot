/**
 * Integration test: actually connects to the real Minecraft server.
 * Only runs when RUN_INTEGRATION=1 environment variable is set.
 */

const { spawn } = require('child_process');
const path = require('path');

const SERVER_HOST = process.env.MC_HOST || 'wound-gig.gl.joinmc.link';
const SERVER_PORT = parseInt(process.env.MC_PORT || '25565', 10);
const TEST_TIMEOUT = 35000;

describe('Bot Integration', () => {
  let botProcess;
  let output = '';

  beforeAll((done) => {
    // Spawn the bot as a child process
    botProcess = spawn('node', [path.join(__dirname, '..', '..', 'index.js')], {
      env: {
        ...process.env,
        MC_HOST: SERVER_HOST,
        MC_PORT: String(SERVER_PORT),
        MC_USERNAME: `TestBot_${Date.now() % 10000}`,
        MC_DEBUG: 'true',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    botProcess.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      console.log('[bot]', text.trim());
    });

    botProcess.stderr.on('data', (data) => {
      const text = data.toString();
      output += text;
      console.log('[bot]', text.trim());
    });

    botProcess.on('close', (code) => {
      if (code !== 0 && !output.includes('Bot spawned')) {
        console.log(`Bot process exited with code ${code}`);
      }
    });

    // Give the bot time to connect and spawn
    setTimeout(done, 2000);
  }, 5000);

  afterAll(() => {
    if (botProcess && !botProcess.killed) {
      botProcess.kill('SIGINT');
    }
  });

  it(
    'should connect to the server and spawn',
    (done) => {
      const maxWait = 30000;
      const start = Date.now();

      const check = () => {
        const elapsed = Date.now() - start;

        if (output.includes('[bot] Spawned at')) {
          console.log(`SUCCESS: Bot spawned after ${elapsed}ms`);
          return done();
        }

        if (output.includes('kicked')) {
          console.log('FAIL: Bot was kicked from server');
          // This is informative even in failure — capture the reason
        }

        if (output.includes('FML') && output.includes('handshake')) {
          console.log('Forge handshake output detected');
        }

        if (elapsed >= maxWait) {
          // Check if we at least connected (even if spawn didn't fire)
          if (output.includes('Connection closed') || output.includes('Bot error')) {
            return done(new Error(`Bot failed to connect within ${maxWait}ms. Last output: ${output.slice(-500)}`));
          }
          return done(new Error(`Bot did not spawn within ${maxWait}ms. Output: ${output.slice(-500)}`));
        }

        setTimeout(check, 500);
      };

      // If process already exited, handle that
      if (botProcess.exitCode !== null && botProcess.exitCode !== 0) {
        return done(new Error(`Bot process exited early with code ${botProcess.exitCode}. Output: ${output.slice(-500)}`));
      }

      check();
    },
    TEST_TIMEOUT
  );
});
