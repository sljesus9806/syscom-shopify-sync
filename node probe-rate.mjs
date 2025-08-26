import axios from "axios";

const SYS_OAUTH = "https://developers.syscom.mx/oauth/token";
const SYS_BASE  = "https://developers.syscom.mx/api/v1";

const { SYSCOM_CLIENT_ID, SYSCOM_CLIENT_SECRET } = process.env;

async function syscomToken() {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: SYSCOM_CLIENT_ID,
    client_secret: SYSCOM_CLIENT_SECRET,
  });
  const { data } = await axios.post(SYS_OAUTH, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return data.access_token;
}

async function getExchangeRate(token) {
  const { data } = await axios.get(`${SYS_BASE}/tipocambio`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return {
    raw: data,
    normal: parseFloat(data?.normal ?? "0"),
    un_dia: parseFloat(data?.un_dia ?? "0"),
  };
}

const token = await syscomToken();
const rate = await getExchangeRate(token);
console.log("tipocambio:", rate);
