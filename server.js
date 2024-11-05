const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const cors = require('cors');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const imaps = require('imap-simple');
const session = require('express-session'); // Corrigido: importa o `express-session`
const multer = require('multer');
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

// Configuração de sessão para autenticação
app.use(session({
    secret: process.env.SESSION_SECRET || 'chave-secreta',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }  // Use `secure: true` em produção com HTTPS
}));

// Middleware para autenticação
function isAuthenticated(req, res, next) {
    if (req.session.authenticated) {
        return next();
    }
    res.redirect('/login');
}

// Rota de login (visualizar o formulário de login)
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Rota para autenticar login
app.post('/admin/login', express.urlencoded({ extended: true }), (req, res) => {
    const { username, password } = req.body;
    const adminUsername = process.env.ADMIN_USERNAME;
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (username === adminUsername && password === adminPassword) {
        req.session.authenticated = true;
        res.redirect('/admin/upload');
    } else {
        res.status(401).send('Usuário ou senha incorretos.');
    }
});

// Rota de logout
app.get('/admin/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Rota de upload para substituir as imagens dos dias da semana
app.get('/admin/upload', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Configuração do `multer` para salvar na pasta `public/images`
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, 'public/images'));
    },
    filename: (req, file, cb) => {
        const filePath = path.join(__dirname, 'public/images', file.originalname);
        
        // Se o arquivo já existir, removê-lo
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);  // Apagar o arquivo existente
        }
        
        cb(null, file.originalname);  // Manter o mesmo nome do arquivo
    }
});

const upload = multer({ storage: storage });

// Configuração da pasta `public` para arquivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Rota para o upload dos arquivos
app.post('/admin/upload', upload.single('segunda'), (req, res) => {
    if (req.file) {
        console.log('Arquivo recebido:', req.file);
        res.status(200).send('Upload realizado com sucesso!');
    } else {
        res.status(400).send('Erro no upload do arquivo.');
    }
});

// Servir o cardápio para verificação
app.get('/cardapio.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'cardapio.html'));
});

// Configurações iniciais
app.use(express.static('public'));
app.use(cors());
app.use(bodyParser.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'chave-secreta',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: true }  // `secure: true` em produção com HTTPS
}));

// Função de autenticação
function isAuthenticated(req, res, next) {
    if (req.session.authenticated) {
        return next();
    }
    res.redirect('/login');
}

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
        to: 'recursoshumanos@metalburgo.com.br',
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
        to: 'recursoshumanos@metalburgo.com.br',
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

// Agendamento diário e mensal
cron.schedule('0 10 * * 1-5', enviarEmailDiario, {
    timezone: "America/Sao_Paulo"
});

cron.schedule('0 1 1 * *', () => {
    const today = new Date();
    const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    if (today.getDate() === lastDay) {
        enviarEmailMensal();
    }
});

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});
function getCardapioImagePath() {
    const now = new Date();
    const currentDay = now.getDay(); // 0 = Domingo, 1 = Segunda, ..., 5 = Sexta, 6 = Sábado
    const currentHour = now.getHours();
    let fileName;

    // Sábado e domingo sempre mostram o cardápio de segunda-feira
    if (currentDay === 0 || currentDay === 6) {
        fileName = 'segunda.jpeg';
    } 
    // Segunda a sexta, mas antes das 10h, mostra o cardápio do dia anterior
    else if (currentHour < 13) {
        if (currentDay === 1) {
            fileName = 'segunda.jpeg';
        } else {
            fileName = `${['segunda', 'terca', 'quarta', 'quinta', 'sexta'][currentDay - 1]}.jpeg`;
        }
    } 
    // Segunda a sexta, após 10h, mostra o cardápio do próprio dia
    else {
<<<<<<<<< Temporary merge branch 1
        fileName = `${['segunda', 'terca', 'quarta', 'quinta', 'sexta'][currentDay - 1]}.jpeg`;
=========
        fileName = `${['segunda', 'terca', 'quarta', 'quinta', 'sexta'][currentDay]}.jpeg`;
>>>>>>>>> Temporary merge branch 2
    }

    return path.join(__dirname, 'public', 'images', fileName);
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

// Configuração de sessão
app.use(session({
    secret: process.env.SESSION_SECRET || 'chave-secreta',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }  // `secure: true` em produção com HTTPS
}));

// Middleware para verificar se o usuário está autenticado
function isAuthenticated(req, res, next) {
    if (req.session.authenticated) {
        return next();
    }
    res.redirect('/login');
}


// Rota de upload protegida
app.get('/admin/upload', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.post('/admin/upload', isAuthenticated, upload.fields([
    { name: 'segunda', maxCount: 1 },
    { name: 'terca', maxCount: 1 },
    { name: 'quarta', maxCount: 1 },
    { name: 'quinta', maxCount: 1 },
    { name: 'sexta', maxCount: 1 }
]), (req, res) => {
    if (!req.files || Object.keys(req.files).length === 0) {
        return res.status(400).send('Nenhum arquivo foi enviado.');
    }
    res.send('Imagens carregadas com sucesso!');
});
// Servir arquivos estáticos da pasta public
app.use(express.static('public'));

// Rota para a página de login
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Rota de autenticação para login
app.post('/admin/login', express.urlencoded({ extended: true }), (req, res) => {
    const { username, password } = req.body;

    // Verificar credenciais (defina essas variáveis de ambiente para produção)
    const adminUsername = process.env.ADMIN_USERNAME;
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (username === adminUsername && password === adminPassword) {
        req.session.authenticated = true;
        res.redirect('/admin/upload');
    } else {
        res.send('Usuário ou senha incorretos.');
    }
});

// Rota para logout
app.get('/admin/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Rota de upload protegida
app.get('/admin/upload', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});


// Rota para processar o upload das imagens, protegida
app.post('/admin/upload', isAuthenticated, upload.fields([
    { name: 'segunda', maxCount: 1 },
    { name: 'terca', maxCount: 1 },
    { name: 'quarta', maxCount: 1 },
    { name: 'quinta', maxCount: 1 },
    { name: 'sexta', maxCount: 1 }
]), (req, res) => {
    res.send('Imagens carregadas com sucesso!');
});

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});

// Rota para download do arquivo pedidos.csv
app.get('/api/pedidos/download', isAuthenticated, (req, res) => {
    const filePath = path.join(__dirname, csvFilePath);

    // Verifica se o arquivo existe antes de enviá-lo
    if (fs.existsSync(filePath)) {
        res.download(filePath, 'pedidos.csv', (err) => {
            if (err) {
                console.error('Erro ao enviar o arquivo:', err);
                res.status(500).send('Erro ao baixar o arquivo.');
            }
        });
        res.download(filePath, 'pedidos_mensal.csv', (err) => {
            if (err) {
                console.error('Erro ao enviar o arquivo:', err);
                res.status(500).send('Erro ao baixar o arquivo.');
            }
        });
    } else {
        res.status(404).send('Arquivo não encontrado.');
    }
});

module.exports = { enviarEmailDiario };
