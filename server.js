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

// Rota para salvar o pedido no CSV
app.post('/api/pedidos/salvar', (req, res) => {
    const { nome, empresa, almoco, salada, sobremesa, porcao, observacoes } = req.body;
    checkAndWriteHeader();

    const novoPedido = `${nome};${empresa};${almoco};${salada};${sobremesa};${porcao};${observacoes}\n`;
    fs.appendFile(csvFilePath, novoPedido, (err) => {
        if (err) {
            console.error('Erro ao salvar o pedido no CSV:', err);
            return res.status(500).json({ message: 'Erro ao salvar o pedido' });
        }
        res.json({ message: 'Pedido salvo com sucesso!' });
    });
});

// Rota para enviar o CSV por e-mail
app.post('/api/pedidos/enviar-email', (req, res) => {
    const csvContent = fs.readFileSync(csvFilePath).toString();

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_PASS
        }
    });

    const mailOptions = {
        from: `"No Reply" <${process.env.GMAIL_USER}>`,  // Nome exibido será "no reply"
        to: 'cicero.rda@gmail.com',
        bcc: 'ttcicero@gmail.com',  // Destinatário(s) em CCO (invisível)
        subject: 'Relatório de Pedidos de Refeição',
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
            console.error('Erro ao enviar e-mail:', error);
            return res.status(500).json({ message: 'Erro ao enviar o e-mail' });
        }
        res.json({ message: 'E-mail enviado com sucesso!' });
    });
});

app.listen(port, () => {
    console.log(`Servidor rodando em ${port}`);
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

