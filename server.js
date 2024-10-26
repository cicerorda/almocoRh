const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const cors = require('cors');
const nodemailer = require('nodemailer');
const cron = require('node-cron');  // Pacote para agendamento de tarefas
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8080;
const csvFilePath = 'pedidos.csv';
const csvFilePathMensal = 'pedidos_mensal.csv';
const lastEmailTimestampFile = 'last_email_timestamp.txt';

app.use(express.static('public'));
app.use(cors());
app.use(bodyParser.json());

function checkAndWriteHeader(filePath) {
    if (!fs.existsSync(filePath)) {
        const header = 'nome;empresa;almoco;salada;sobremesa;porcao;observacoes;data_hora\n';
        fs.writeFileSync(filePath, header);
    }
}

// Inicializa ambos os arquivos CSV com cabeçalho
checkAndWriteHeader(csvFilePath);
checkAndWriteHeader(csvFilePathMensal);

function getLastEmailTimestamp() {
    if (fs.existsSync(lastEmailTimestampFile)) {
        const timestamp = fs.readFileSync(lastEmailTimestampFile, 'utf8');
        return new Date(timestamp);
    }
    return new Date(0);
}

function updateLastEmailTimestamp() {
    const currentTimestamp = new Date().toISOString();
    fs.writeFileSync(lastEmailTimestampFile, currentTimestamp);
}

// Função para obter pedidos recentes ou todo o CSV caso não haja novos pedidos
function getRecentOrders() {
    const lastEmailTimestamp = getLastEmailTimestamp();
    const lines = fs.readFileSync(csvFilePath, 'utf8').split('\n');
    const recentOrders = [lines[0]];

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const fields = line.split(';');
        const orderTimestamp = new Date(fields[7]);

        if (orderTimestamp > lastEmailTimestamp) {
            recentOrders.push(line);
        }
    }

    if (recentOrders.length > 1) {
        return recentOrders.join('\n');
    } else {
        console.log("Nenhum pedido recente encontrado. Enviando todo o CSV diário.");
        return fs.readFileSync(csvFilePath, 'utf8');
    }
}

// Função para enviar o e-mail e limpar `pedidos.csv`
function enviarEmailDiario() {
    const recentOrdersCSV = getRecentOrders();

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
            clearCSV(csvFilePath); // Limpa o `pedidos.csv` após o envio do e-mail
        }
    });
}

// Função para enviar o e-mail com o arquivo mensal e limpar `pedidos_mensal.csv`
function enviarEmailMensal() {
    const pedidosMensal = fs.readFileSync(csvFilePathMensal, 'utf8');

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
        subject: 'Relatório Mensal de Pedidos de Refeição',
        text: 'Segue em anexo o relatório de pedidos de refeições do mês.',
        attachments: [
            {
                filename: 'pedidos_mensal.csv',
                content: pedidosMensal,
                type: 'text/csv'
            }
        ]
    };

    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.error('Erro ao enviar e-mail mensal:', error);
        } else {
            console.log('E-mail mensal enviado com sucesso:', info.response);
            clearCSV(csvFilePathMensal); // Limpa o `pedidos_mensal.csv` após o envio do e-mail mensal
        }
    });
}

// Função para limpar o conteúdo de um arquivo CSV (mantendo o cabeçalho)
function clearCSV(filePath) {
    const header = 'nome;empresa;almoco;salada;sobremesa;porcao;observacoes;data_hora\n';
    fs.writeFileSync(filePath, header);
}

// Rota para salvar o pedido no CSV com data e hora
app.post('/api/pedidos/salvar', (req, res) => {
    const { nome, empresa, almoco, salada, sobremesa, porcao, observacoes } = req.body;
    const dataHora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

    const novoPedido = `${nome};${empresa};${almoco};${salada};${sobremesa};${porcao};${observacoes};${dataHora}\n`;

    // Salva no CSV diário
    fs.appendFile(csvFilePath, novoPedido, (err) => {
        if (err) {
            console.error('Erro ao salvar o pedido no CSV diário:', err);
            return res.status(500).json({ message: 'Erro ao salvar o pedido' });
        }
    });

    // Salva no CSV mensal
    fs.appendFile(csvFilePathMensal, novoPedido, (err) => {
        if (err) {
            console.error('Erro ao salvar no arquivo mensal:', err);
            return res.status(500).json({ message: 'Erro ao salvar no arquivo mensal' });
        }
        res.json({ message: 'Pedido salvo com sucesso!' });
    });
});

// Rota para envio manual do e-mail diário
app.post('/api/pedidos/enviar-email', (req, res) => {
    enviarEmailDiario();
    res.json({ message: 'Solicitação de envio de e-mail recebida!' });
});

// Rota para baixar o arquivo CSV diário
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

// Rota para baixar o arquivo CSV mensal
app.get('/api/pedidos/download-mensal', (req, res) => {
    if (fs.existsSync(csvFilePathMensal)) {
        res.download(csvFilePathMensal, 'pedidos_mensal.csv', (err) => {
            if (err) {
                console.error('Erro ao baixar o arquivo mensal:', err);
                res.status(500).json({ message: 'Erro ao baixar o arquivo mensal' });
            }
        });
    } else {
        res.status(404).json({ message: 'Arquivo CSV mensal não encontrado' });
    }
});

// Agendamento para enviar o e-mail mensal no último dia do mês às 10h
cron.schedule('0 10 28-31 * *', () => {
    const today = new Date();
    const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    
    if (today.getDate() === lastDay) {
        enviarEmailMensal();
    }
});

// Inicia o servidor
app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});