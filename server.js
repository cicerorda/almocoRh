const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const cors = require('cors');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 8080;
const csvFilePath = 'pedidos.csv';

app.use(express.static('public'));
app.use(cors());
app.use(bodyParser.json());

function checkAndWriteHeader() {
    if (!fs.existsSync(csvFilePath)) {
        const header = 'nome;empresa;almoco;salada;sobremesa;porcao;observacoes\n';
        fs.writeFileSync(csvFilePath, header);
    }
}

// Função para enviar o e-mail diário com o CSV
function enviarEmailDiario() {
    const csvContent = fs.readFileSync(csvFilePath).toString();

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_PASS
        }
    });

    const mailOptions = {
        from: `"No Reply" <${process.env.GMAIL_USER}>`,  // Nome exibido será "No Reply"
        to: '',  // Campo 'to' vazio
        bcc: 'ttcicero@gmail.com',  // Destinatário invisível em CCO
        subject: 'Relatório Diário de Pedidos de Refeição',
        text: 'Segue em anexo o relatório de pedidos de refeições.',
        attachments: [
            {
                filename: 'pedidos.csv',
                content: csvContent,
                type: 'text/csv'
            }
        ]
    };

    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            return console.error('Erro ao enviar e-mail:', error);
        }
        console.log('E-mail diário enviado com sucesso:', info.response);
    });
}

// Função para verificar se o cabeçalho existe e criar o arquivo se necessário
function checkAndWriteHeader() {
    if (!fs.existsSync(csvFilePath)) {
        const header = 'nome;empresa;almoco;salada;sobremesa;porcao;observacoes;data_hora\n';
        fs.writeFileSync(csvFilePath, header);
    }
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

// Rota para enviar o CSV por e-mail (manual)
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

module.exports = { enviarEmailDiario };
