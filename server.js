const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const cors = require('cors');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const imaps = require('imap-simple');
const { simpleParser } = require('mailparser');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8080;
const csvFilePath = 'pedidos.csv';
const csvFilePathMensal = 'pedidos_mensal.csv';
const lastEmailTimestampFile = 'last_email_timestamp.txt';

app.use(express.static('public'));
app.use(cors());
app.use(bodyParser.json());

// Configuração do IMAP para verificação de e-mails
const emailConfig = {
    imap: {
        user: process.env.EMAIL_USER,
        password: process.env.EMAIL_PASS,
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        authTimeout: 3000
    }
};

// Função para verificar e baixar imagens do cardápio por e-mail
async function checkForCardapioEmail() {
    try {
        const connection = await imaps.connect(emailConfig);
        await connection.openBox('INBOX');

        const searchCriteria = ['UNSEEN', ['SUBJECT', 'Atualizar Cardapio']];
        const fetchOptions = { bodies: [''], markSeen: true };

        const messages = await connection.search(searchCriteria, fetchOptions);

        for (let message of messages) {
            const all = message.parts.find(part => part.which === '');
            const parsed = await simpleParser(all.body);

            const diasDaSemana = ['segunda', 'terça', 'quarta', 'quinta', 'sexta'];
            for (let attachment of parsed.attachments) {
                const fileName = attachment.filename.toLowerCase().replace(/\.[^/.]+$/, '');
                
                if (diasDaSemana.includes(fileName)) {
                    const filePath = path.join(__dirname, 'public', `${fileName}.jpg`);
                    fs.writeFileSync(filePath, attachment.content);
                    console.log(`Imagem ${fileName}.jpg salva com sucesso.`);
                }
            }
        }
        connection.end();
    } catch (error) {
        console.error('Erro ao verificar e-mails:', error);
    }
}

// Verificação de e-mails a cada 15 minutos
setInterval(checkForCardapioEmail, 15 * 60 * 1000);

// Função para salvar cabeçalhos em arquivos CSV
function checkAndWriteHeader(filePath) {
    if (!fs.existsSync(filePath)) {
        const header = 'nome;empresa;almoco;salada;sobremesa;porcao;observacoes;data_hora\n';
        fs.writeFileSync(filePath, header);
    }
}

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

// Função para obter pedidos recentes ou todo o CSV
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

// Função para enviar e-mail diário e limpar o arquivo CSV
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
            updateLastEmailTimestamp();
            clearCSV(csvFilePath);
        }
    });
}

// Função para enviar e-mail mensal e limpar o arquivo CSV mensal
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
            clearCSV(csvFilePathMensal);
        }
    });
}

// Função para limpar o conteúdo de um arquivo CSV
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
// Função para obter a imagem do cardápio com base no dia e horário
function getCardapioImagePath() {
    const now = new Date();
    const currentDay = now.getDay();
    const currentHour = now.getHours();
    let fileName;

    if (currentDay === 0 || (currentDay === 1 && currentHour < 12)) {
        fileName = 'segunda.jpg';  // Sábado e domingo mostram o cardápio de segunda
    } else if (currentDay === 1 && currentHour >= 12) {
        fileName = 'terça.jpg';
    } else if (currentDay === 2 && currentHour >= 12) {
        fileName = 'quarta.jpg';
    } else if (currentDay === 3 && currentHour >= 12) {
        fileName = 'quinta.jpg';
    } else if (currentDay === 4 && currentHour >= 12) {
        fileName = 'sexta.jpg';
    } else if (currentDay === 5 && currentHour >= 12) {
        fileName = 'segunda.jpg';  // Sexta-feira após 12h já exibe o cardápio de segunda
    } else {
        fileName = `${['segunda', 'terça', 'quarta', 'quinta', 'sexta'][currentDay - 1]}.jpg`;
    }

    return path.join(__dirname, 'public', 'images', fileName); // Certifique-se de que as imagens estão em 'public/images'
}
// Rota para servir a imagem do cardápio
app.get('/api/cardapio/imagem', (req, res) => {
    const imagePath = getCardapioImagePath();
    
    // Define cabeçalho para desativar cache
    res.set('Cache-Control', 'no-store'); 

    res.sendFile(imagePath, (err) => {
        if (err) {
            console.error('Erro ao enviar a imagem do cardápio:', err);
            res.status(500).send('Erro ao carregar a imagem do cardápio.');
        }
    });
});
module.exports = { enviarEmailDiario };
