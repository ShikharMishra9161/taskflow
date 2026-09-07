const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ0ZXN0LXVzZXIiLCJpYXQiOjE3ODg3MTUyNDMsImV4cCI6MTc4ODcxODg0M30.PiawwUUIIAPwJ0Dws9Tc415wdMEPgGVDXDtHtiUtATQ";


async function testOneRequest() {
  const response = await fetch("http://localhost:5000/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      type: "email",
      payload: {
        job: "RATE-LIMIT-RESET-TEST",
      },
    }),
  });

  const data = await response.json();

  console.log(`HTTP ${response.status}`, data);
}

testOneRequest();