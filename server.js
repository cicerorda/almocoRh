const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const cors = require('cors');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8080;
const csvFilePath = 'pedidos.csv';
const lastEmailTimestampFile = 'last_email_timestamp.txt';

app.use(express.static('public'));
app.use(cors());
app.use(bodyParser.json());

function checkAndWriteHeader() {
    if (!fs.existsSync(csvFilePath)) {
        const header = 'nome;empresa;almoco;salada;sobremesa;porcao;observacoes;data_hora\n';
        fs.writeFileSync(csvFilePath, header);
    }
}

function getLastEmailTimestamp() {
    if (fs.existsSync(lastEmailTimestampFile)) {
        const timestamp = fs.readFileSync(lastEmailTimestampFile, 'utf8');
        return new Date(timestamp);
    }
    return new Date(0); // Se não houver um timestamp, retorna uma data inicial (ex: 1970)
}

function updateLastEmailTimestamp() {
    const currentTimestamp = new Date().toISOString();
    fs.writeFileSync(lastEmailTimestampFile, currentTimestamp);
}

// Função para filtrar os pedidos recentes
function getRecentOrders() {
    const lastEmailTimestamp = getLastEmailTimestamp();
    console.log("Último envio de e-mail em:", lastEmailTimestamp);

    const lines = fs.readFileSync(csvFilePath, 'utf8').split('\n');
    const recentOrders = [lines[0]]; // Adiciona o cabeçalho

    // Verifica cada linha de pedido
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const fields = line.split(';');
        const orderTimestamp = new Date(fields[7]); // Campo "data_hora"

        if (orderTimestamp > lastEmailTimestamp) {
            recentOrders.push(line);
        }
    }

    // Verifica se há pedidos recentes
    if (recentOrders.length > 1) {
        return recentOrders.join('\n'); // Retorna apenas os pedidos recentes
    } else {
        console.log("Nenhum pedido recente encontrado. Enviando todo o CSV.");
        return fs.readFileSync(csvFilePath, 'utf8'); // Retorna todo o CSV
    }
}


// Função para enviar o e-mail com os pedidos recentes
function enviarEmailDiario() {
    const recentOrdersCSV = getRecentOrders();
    if (recentOrdersCSV.split('\n').length <= 1) {
        console.log('Nenhum pedido recente para enviar.');
        return;
    }

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_PASS
        }
    });

    const mailOptions = {
        from: `"No Reply" <${process.env.GMAIL_USER}>`,
        to: 'ttcicero@gmail.com',
        bcc: 'ttcicero@gmail.com',
        subject: 'Relatório Diário de Pedidos de Refeição',
        text: 'Segue em anexo o relatório de pedidos de refeições recentes.',
        attachments: [
            {
                filename: 'pedidos.csv',
                content: recentOrdersCSV,
                type: 'text/csv'
            }
        ]
    };

    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.error('Erro ao enviar e-mail:', error);
        } else {
            console.log('E-mail enviado com sucesso:', info.response);
            updateLastEmailTimestamp(); // Atualiza o timestamp após envio bem-sucedido
        }
    });
}

// Rota para salvar o pedido no CSV com data e hora
app.post('/api/pedidos/salvar', (req, res) => {
    const { nome, empresa, almoco, salada, sobremesa, porcao, observacoes } = req.body;
    checkAndWriteHeader();

    // Obter a data e hora atuais
    const dataHora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    // Formatar o pedido com a nova coluna de data e hora
    const novoPedido = `${nome};${empresa};${almoco};${salada};${sobremesa};${porcao};${observacoes};${dataHora}\n`;
    
    // Salvar no CSV
    fs.appendFile(csvFilePath, novoPedido, (err) => {
        if (err) {
            console.error('Erro ao salvar o pedido no CSV:', err);
            return res.status(500).json({ message: 'Erro ao salvar o pedido' });
        }
        res.json({ message: 'Pedido salvo com sucesso!' });
    });
});

// Rota para envio manual do e-mail
app.post('/api/pedidos/enviar-email', (req, res) => {
    enviarEmailDiario();
    res.json({ message: 'Solicitação de envio de e-mail recebida!' });
});

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});
// Rota para baixar o arquivo CSV
app.get('/api/pedidos/download', (req, res) => {
    const path = require('path');
    const csvFilePath = path.join(__dirname, 'pedidos.csv');

    if (fs.existsSync(csvFilePath)) {
        res.download(csvFilePath, 'pedidos.csv', (err) => {
            if (err) {
                console.error('Erro ao baixar o arquivo:', err);
                res.status(500).json({ message: 'Erro ao baixar o arquivo' });
            }
        });
    } else {
        res.status(404).json({ message: 'Arquivo CSV não encontrado' });
    }
});


module.exports = { enviarEmailDiario };
