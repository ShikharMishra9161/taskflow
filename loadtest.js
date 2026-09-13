const autocannon = require('autocannon');

const TOKEN = process.env.LOAD_TEST_TOKEN;

if (!TOKEN) {
  console.error('Set LOAD_TEST_TOKEN env var first');
  process.exit(1);
}

autocannon({
  url: 'http://localhost:3000/jobs',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${TOKEN}`,
  },
  body: JSON.stringify({ type: 'load-test-job', payload: { source: 'autocannon' } }),
  connections: 10,
  duration: 20,
}, (err, result) => {
  if (err) {
    console.error(err);
    return;
  }
  console.log(autocannon.printResult(result));
});
