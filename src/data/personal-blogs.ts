export interface PersonalBlogPerson {
    slug: 'omar' | 'layla' | 'youssef' | 'yacine';
    collection: 'omar' | 'layla' | 'youssef' | 'yacine';
    nameAr: string;
    nameLatin: string;
    tagline: string;
    bio: string;
    accent: string;
}

export const PERSONAL_COLLECTIONS = ['omar', 'layla', 'youssef', 'yacine'] as const;

export const personalBlogs: Record<string, PersonalBlogPerson> = {
    omar: {
        slug: 'omar',
        collection: 'omar',
        nameAr: 'عمر الحربي',
        nameLatin: 'OMAR AL-HARBI',
        tagline: 'هندسة البرمجيات · الذكاء الاصطناعي',
        bio: 'مهندس برمجيات ومهتم بالذكاء الاصطناعي. أكتب عن المصادر المفتوحة، الأمن السيبراني، والشركات الناشئة التقنية، وأحاول المساهمة في إثراء المحتوى التقني العربي.',
        accent: '#2563eb',
    },
    layla: {
        slug: 'layla',
        collection: 'layla',
        nameAr: 'ليلى المنصوري',
        nameLatin: 'LAYLA AL-MANSOURI',
        tagline: 'العلوم البيئية · الاستدامة',
        bio: 'باحثة في العلوم البيئية، مهتمة بالاستدامة والطاقة المتجددة والنظم البيئية الصحراوية. أوثّق ملاحظاتي بالكاميرا كما أوثقها بالكلمات.',
        accent: '#16a34a',
    },
    youssef: {
        slug: 'youssef',
        collection: 'youssef',
        nameAr: 'يوسف الخطيب',
        nameLatin: 'YOUSSEF EL-KHATIB',
        tagline: 'الاقتصاد · السياسات العامة',
        bio: 'باحث في الاقتصاد والسياسات العامة، مهتم بقضايا التنمية الاقتصادية وريادة الأعمال، وأقرأ في التاريخ والأدب العربي بقدر ما أقرأ في التقارير الاقتصادية.',
        accent: '#b45309',
    },
    yacine: {
        slug: 'yacine',
        collection: 'yacine',
        nameAr: 'ياسين بن سعيد',
        nameLatin: 'YACINE BENSAÏD',
        tagline: 'البلوكتشين · العقود الذكية',
        bio: 'مهندس عقود ذكية جزائري متخصص في تطوير البلوكتشين. مهتم بالبيتكوين والإيثيريوم والتمويل اللامركزي والاستثمار في العملات الرقمية، وأتابع عن قرب تقاطع الأمن السيبراني والذكاء الاصطناعي مع عالم Web3 والمصادر المفتوحة.',
        accent: '#7c3aed',
    },
};
